import { execFileSync } from "node:child_process";

/**
 * Processes a test run started and left behind: a daemon `ion daemon start` spawned detached, the agents it or an
 * in-process server spawned (2026-11-23: ~13 test daemons, some 1½ days old, and their opencode and grok children
 * were still running after `pnpm check`s). Found by the run's folder in their environment (TMPDIR, ION_HOME,
 * XDG_CACHE_HOME all point under it), never by their command line; never the test runner itself or its workers.
 */
export type Proc = { pid: number; pgid: number; command: string };

/**
 * `dir` as the value (or the start of the value) of a variable in `env`: `NAME=dir`, followed by `/`, a space or the
 * end (so /tmp/run-a never matches /tmp/run-ab). Never a command line: a shell or an editor that only names the folder
 * isn't the run's.
 */
const inEnv = (env: string, dir: string) => {
  const needle = `=${dir}`;
  for (let i = env.indexOf(needle); i !== -1; i = env.indexOf(needle, i + 1)) {
    const next = env[i + needle.length];
    if (next === undefined || next === "/" || next === " ") return true;
  }
  return false;
};

/** A ps line's first column, as a number, and the rest: "  123 node x" → [123, "node x"]. */
function head(line: string): [number, string] | null {
  const t = line.trimStart();
  const space = t.indexOf(" ");
  const n = Number(t.slice(0, space));
  return space > 0 && Number.isInteger(n) ? [n, t.slice(space).trimStart()] : null;
}

const ps = (format: string, env: boolean): Map<number, string> => {
  let out = "";
  try {
    out = execFileSync("/bin/ps", [env ? "axeww" : "axww", "-o", format], {
      encoding: "utf8",
      maxBuffer: 64 << 20,
    });
  } catch {
    return new Map();
  }
  return new Map(out.split("\n").flatMap((line) => (head(line) ? [head(line)!] : [])));
};

/** Every process on this computer: its group, its command, and its environment (what `ps e` adds after it). */
function all(): (Proc & { ppid: number; env: string })[] {
  const withEnv = ps("pid=,command=", true);
  const plain = ps("pid=,pgid=,command=", false);
  const parents = ps("pid=,ppid=", false);
  return [...plain].flatMap(([pid, rest]) => {
    const g = head(rest);
    const line = withEnv.get(pid);
    if (!g || !line?.startsWith(g[1])) return [];
    return [{ pid, pgid: g[0], ppid: Number(parents.get(pid)), command: g[1], env: line.slice(g[1].length) }];
  });
}

/**
 * The vitest runner and its workers carry the run's TMPDIR too; they end on their own. The whole command: on CI the
 * vitest path comes late in a worker's (macOS CI, PR #37: a worker still ending at teardown counted as left running).
 */
const isRunner = (p: Proc) => /\/vitest\/|vitest\.mjs/.test(p.command);

/**
 * The helper vitest 5.1.1 forks itself (PR #42, 2026-11-28): it renames itself "vitest-watchdog" (no vitest path left in
 * the command), carries the run's TMPDIR and ends when the runner does. Only that exact name, and only as a child of
 * the runner (`runner`): a daemon or an agent a test started is never called that, nor a child of the runner's.
 */
export const isRunnersWatchdog = (p: { ppid: number; command: string }, runner: number) =>
  p.ppid === runner && p.command.trim() === "vitest-watchdog";

/**
 * Live processes started under `dir` (a run's folder or one test's ion home). A dead run's own workers too, with
 * `runners` (a worker whose runner was killed carries on alone: seen 2026-11-23).
 */
export function processesUnder(dir: string, runners = false): Proc[] {
  return all()
    .filter((p) => p.pid !== process.pid && (runners || !(isRunner(p) || isRunnersWatchdog(p, process.pid))) && inEnv(p.env, dir))
    .map(({ pid, pgid, command }) => ({ pid, pgid, command: command.slice(0, 160) }));
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const signal = (pid: number) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
};

/** Waits (without returning to the event loop: teardowns here are synchronous) up to `ms` for `done`. */
function waitFor(done: () => boolean, ms: number): void {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let left = ms; left > 0 && !done(); left -= 50) Atomics.wait(pause, 0, 0, 50);
}

/**
 * Kills every process under `dir`, and the process group of each that leads its own (a detached daemon and the
 * agents it started), then waits for them to be gone. Returns what it found.
 */
export function killUnder(dir: string, runners = false): Proc[] {
  const found = processesUnder(dir, runners);
  for (const p of found) {
    if (p.pgid === p.pid) signal(-p.pgid);
    signal(p.pid);
  }
  waitFor(
    () => found.every((p) => !alive(p.pid) || !processesUnder(dir, runners).some((q) => q.pid === p.pid)),
    5000,
  );
  return found;
}
