import { spawn } from "node:child_process";
import { isStandardEnv, type RunSandbox, sandboxed } from "@ion/adapter-kit";

/** How much of a hook's output is kept (its last characters): shown as its last result. */
export const TAIL = 2000;
/** How much of its stderr is kept from the start (a refusal's reason is cut shorter still). */
const ERR_HEAD = 4000;

export type HookRun = {
  run: string;
  stdin: string;
  env: Record<string, string>;
  cwd: string;
  limitMs: number;
  /** Where its process group is kept while it runs (so ion can stop it). */
  live?: Set<number>;
  /** The OS sandbox it runs in (hooks/reach.ts). */
  sandbox?: RunSandbox;
};
/** `code` null: it was stopped (its time limit) or couldn't start. */
export type HookResult = { code: number | null; ms: number; tail: string; stderr: string; timedOut: boolean };

/**
 * A hook's environment: the variables any command needs to run (its PATH, home, user, shell, locale, temp folder,
 * proxy), which ion (`ION_HOME`, so `ion` in a hook reaches this daemon) and which event it runs on, for which
 * project and chat. The chat is `ION_EVENT_CHAT`, never `ION_CHAT` (a chat agent's marker: `ion` would refuse to
 * run). Nothing else of ion's: no key, no run's address.
 */
export function hookEnv(
  ion: { event: string; project?: string; chat?: string },
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const std = Object.entries(base).filter(
    (e): e is [string, string] => e[1] !== undefined && isStandardEnv(e[0]) && !e[0].startsWith("__CF_"),
  );
  return {
    ...Object.fromEntries(std),
    ...(base.ION_HOME ? { ION_HOME: base.ION_HOME } : {}),
    ION_EVENT: ion.event,
    ...(ion.project ? { ION_PROJECT: ion.project } : {}),
    ...(ion.chat ? { ION_EVENT_CHAT: ion.chat } : {}),
  };
}

/** Stops the hook and everything it started (its own process group). */
function stopGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/** Stops every hook still running, with all each started. */
export function stopHooks(live: Set<number>): void {
  for (const pid of live) stopGroup(pid);
  live.clear();
}

/**
 * Runs a hook's command with /bin/sh -c in its folder, the event on stdin, stopped (with all it started) at its time
 * limit. When it ends, anything it left running in the background is stopped too. Keeps the last 2,000 characters of its output (stdout and stderr as they came) and the start of its stderr.
 */
export function runHook(o: HookRun): Promise<HookResult> {
  const started = Date.now();
  let tail = "";
  let stderr = "";
  return new Promise((resolve) => {
    // The command is exactly your hook's, as you configured it (a shell line, by design); nothing of ion's or of the
    // environment is added to it: values reach it only through its env (CodeQL, PR #25).
    const sh = sandboxed(o.sandbox, "/bin/sh", ["-c", o.run]);
    const child = spawn(sh.command, sh.args, {
      cwd: o.cwd,
      env: o.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let done = false;
    if (child.pid) o.live?.add(child.pid);
    const finish = (code: number | null, timedOut = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stopGroup(child.pid);
      if (child.pid) o.live?.delete(child.pid);
      resolve({ code, ms: Date.now() - started, tail, stderr, timedOut });
    };
    const timer = setTimeout(() => finish(null, true), o.limitMs);
    const keep = (chunk: Buffer) => {
      tail = (tail + chunk.toString("utf8")).slice(-TAIL);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", (chunk: Buffer) => {
      keep(chunk);
      if (stderr.length < ERR_HEAD) stderr = (stderr + chunk.toString("utf8")).slice(0, ERR_HEAD);
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
    // Something it left running in the background may hold its output open: the hook itself has ended.
    child.on("exit", (code) => setTimeout(() => finish(code), 200).unref());
    // A hook that doesn't read its stdin (or exits first) is fine.
    child.stdin.on("error", () => {});
    child.stdin.end(o.stdin);
  });
}
