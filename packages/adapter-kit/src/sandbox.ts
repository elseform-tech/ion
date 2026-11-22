import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { whichOnPath } from "./system.js";

/**
 * What a run's sandbox keeps away and lets through (the user, 2026-11-21: agents run in the OS sandbox, away from
 * ion's own files). A path in `read` or `write` lies inside a denied folder (the run's own there); `noWrite` holds
 * anywhere.
 */
export type SandboxPaths = {
  /** No reads or writes under these: ion's data, config and cache folders (daemon.json, mcp.json, the vault…). */
  deny: string[];
  /** Read (and run) only, inside a denied folder: the run's skills plugin, ion's `ion` launcher. */
  read: string[];
  /** Read and write, inside a denied folder: the run's worktree, a server's own folder. */
  write: string[];
  /** No writes under these, wherever they are: the agent's own config (nothing persists from a run). */
  noWrite: string[];
};

/** How this computer sandboxes: macOS's Seatbelt (`sandbox-exec`), Linux's bubblewrap, or not at all. */
export type SandboxKind = "seatbelt" | "bwrap" | "none";

/**
 * A run's sandbox: how, its paths, and ion's data folder (where its Seatbelt rules file is kept, in a folder every
 * run is denied). Absent from a start: the run isn't sandboxed.
 */
export type RunSandbox = { kind: SandboxKind; paths: SandboxPaths; dataDir: string };

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** The path and, when different, its real path (links followed as far as the path exists: /tmp is /private/tmp). */
export function realForms(p: string): string[] {
  const abs = resolve(p);
  const rest: string[] = [];
  for (let head = abs; ; head = dirname(head)) {
    try {
      const real = join(realpathSync(head), ...rest);
      return real === abs ? [abs] : [abs, real];
    } catch {
      if (dirname(head) === head) return [abs];
      rest.unshift(basename(head));
    }
  }
}

/**
 * A path the sandbox's rules can hold (CodeQL, PR #25, 2026-11-22): one with a NUL, a newline or a carriage return is
 * refused outright, never escaped (it could end a rule and start another).
 */
function checked(p: string): string {
  if (/[\0\n\r]/.test(p))
    throw new Error(`ion: a sandbox path can't hold a NUL or a line break: ${JSON.stringify(p)}`);
  return p;
}

const allForms = (ps: string[]) => [...new Set(ps.map(checked).flatMap(realForms).map(checked))];

/** Every folder above `p`, nearest first, up to the root. */
function ancestors(p: string): string[] {
  const out: string[] = [];
  for (let d = dirname(p); ; d = dirname(d)) {
    out.push(d);
    if (dirname(d) === d) return out;
  }
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

/** A path as a Seatbelt string. */
const sbString = (p: string) => `"${p.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
const subpaths = (ps: string[]) => ps.map((p) => `(subpath ${sbString(p)})`).join(" ");
const literals = (ps: string[]) => ps.map((p) => `(literal ${sbString(p)})`).join(" ");

/**
 * What would run a program outside the sandbox (task review, 2026-11-21: `open -g Probe.app` started an app through
 * LaunchServices, which copied daemon.json): LaunchServices' services, and Apple Events to other apps. node, git,
 * curl, python and the agents themselves don't need them.
 */
const OUTSIDE = [
  '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") (global-name-prefix "com.apple.lsd.") (global-name "com.apple.coreservices.quarantine-resolver"))',
  "(deny appleevent-send)",
];

/**
 * The Seatbelt profile for a run: everything as it is (`allow default`: network, the agent's login, the project),
 * except ion's folders, which can't be read or written; the folders above them can't be renamed or removed (moving
 * one would carry ion's files out from under the rule); the folders that hold the run's own paths can be looked at,
 * not listed; then the run's own paths; then the agent's config, which can't be written. Later rules win.
 */
export function seatbeltProfile(p: SandboxPaths): string {
  const deny = allForms(p.deny);
  const read = allForms(p.read);
  const write = allForms(p.write);
  const noWrite = allForms(p.noWrite);
  // The folders above ion's and above the agent's config can't be renamed or removed (moving one would carry what's
  // inside out from under its rule); a side effect: a run can't rename, remove or chmod them either.
  const kept = [...deny, ...noWrite];
  const above = [...new Set(kept.flatMap(ancestors))].filter((a) => !deny.some((d) => inside(a, d)));
  const between = [...new Set([...read, ...write].flatMap(ancestors))].filter((a) =>
    deny.some((d) => inside(a, d)),
  );
  const lines = ["(version 1)", "(allow default)", ...OUTSIDE];
  if (deny.length) lines.push(`(deny file-read* file-write* ${subpaths(deny)})`);
  if (above.length) lines.push(`(deny file-write* ${literals(above)})`);
  if (between.length) lines.push(`(allow file-read-metadata ${literals(between)})`);
  if (read.length) lines.push(`(allow file-read* ${subpaths(read)})`);
  if (write.length) lines.push(`(allow file-read* file-write* ${subpaths(write)})`);
  if (noWrite.length) lines.push(`(deny file-write* ${subpaths(noWrite)})`);
  return `${lines.join("\n")}\n`;
}

/**
 * bubblewrap's arguments for a run (before the command): the whole filesystem as it is, an empty folder over each
 * of ion's, the run's own paths bound back (read-only or writable), the agent's config read-only. Not `--ro-bind /
 * /`: a read-only root would stop agents writing their own sessions, caches and temp files, which stay as they are.
 * Its own process list (`--unshare-pid`, a fresh /proc): `/proc/<ion's pid>/root` would reach the real folders.
 * Its own session (no TIOCSTI into the terminal), its own /dev/shm, and no D-Bus session socket (task review,
 * 2026-11-21).
 */
export function bwrapArgs(p: SandboxPaths, env: NodeJS.ProcessEnv = process.env): string[] {
  const args = [
    ...["--die-with-parent", "--new-session", "--unshare-pid", "--bind", "/", "/"],
    ...["--dev", "/dev", "--proc", "/proc", "--tmpfs", "/dev/shm"],
  ];
  // Each path is its own argument (no shell reads them); one with a NUL or a line break is refused (CodeQL, PR #25).
  if (env.XDG_RUNTIME_DIR) args.push("--tmpfs", checked(join(env.XDG_RUNTIME_DIR, "bus")));
  for (const d of allForms(p.deny)) args.push("--tmpfs", d);
  for (const r of allForms(p.read)) args.push("--ro-bind-try", r, r);
  for (const w of allForms(p.write)) args.push("--bind-try", w, w);
  for (const n of allForms(p.noWrite)) args.push("--ro-bind-try", n, n);
  return args;
}

/** The rules files this process wrote, removed when it ends. */
const written = new Set<string>();

/** Removes the rules files this process wrote (when it ends; a started sandbox has read its own already). */
export function removeProfiles(): void {
  for (const f of written) rmSync(f, { force: true });
  written.clear();
}
process.on("exit", removeProfiles);

/**
 * Writes a run's Seatbelt rules to a file and returns its path (CodeQL, PR #25, 2026-11-22: the rules were text on
 * sandbox-exec's command line, built from paths taken from the environment). The file is `<data>/sandbox/<sha256>.sb`:
 * a fixed folder of ion's data folder, which every run is denied, named by its content; written 0600 to a fresh name
 * (O_CREAT|O_EXCL|O_NOFOLLOW) and moved into place, so a link or a file planted there is never written through.
 */
function profileFile(sb: RunSandbox): string {
  const profile = seatbeltProfile(sb.paths);
  const dir = join(checked(resolve(sb.dataDir)), "sandbox");
  if (!allForms(sb.paths.deny).some((d) => realForms(dir).some((f) => inside(f, d))))
    throw new Error("ion: the sandbox's rules file would be within a run's reach");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory()) throw new Error(`ion: not a folder: ${dir}`);
  chmodSync(dir, 0o700);
  const file = join(dir, `${createHash("sha256").update(profile).digest("hex")}.sb`);
  const fresh = `${file}.${randomBytes(8).toString("hex")}`;
  rmSync(fresh, { force: true });
  const fd = openSync(
    fresh,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, profile);
  } finally {
    closeSync(fd);
  }
  renameSync(fresh, file);
  written.add(file);
  return file;
}

/** A command as the sandbox runs it (unchanged with no sandbox): every process it starts stays inside. */
export function sandboxed(
  sb: RunSandbox | undefined,
  command: string,
  args: string[],
): { command: string; args: string[] } {
  if (!sb || sb.kind === "none") return { command, args };
  if (sb.kind === "seatbelt")
    return { command: SANDBOX_EXEC, args: ["-f", profileFile(sb), command, ...args] };
  return { command: "bwrap", args: [...bwrapArgs(sb.paths), "--", command, ...args] };
}

/** Adds paths to a run's sandbox (an agent's own: its config folder, ion's folder for it). */
export function withPaths(sb: RunSandbox | undefined, more: Partial<SandboxPaths>): RunSandbox | undefined {
  if (!sb) return sb;
  const add = (k: keyof SandboxPaths) => [...sb.paths[k], ...(more[k] ?? [])];
  return {
    kind: sb.kind,
    paths: { deny: add("deny"), read: add("read"), write: add("write"), noWrite: add("noWrite") },
    dataDir: sb.dataDir,
  };
}

/** Whether a trial command runs: the sandbox works here (it doesn't inside another sandbox, as macOS refuses). */
function works(file: string, args: string[]): boolean {
  try {
    execFileSync(file, args, { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

let known: SandboxKind | undefined;

/**
 * How this computer sandboxes runs, tried once: Seatbelt on macOS; bubblewrap on Linux (Landlock grants access by
 * folder and can't take one back under the home it allows, so it can't keep ion's folders away: docs/research/
 * sandbox.md). "none" where neither runs (missing, or ion itself already in a sandbox).
 */
export function sandboxKind(): SandboxKind {
  if (known) return known;
  if (process.platform === "darwin")
    known = works(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"]) ? "seatbelt" : "none";
  else if (process.platform === "linux") {
    const bwrap = whichOnPath("bwrap");
    // Tried with the flags a run gets (task review, 2026-11-21): a kernel without user namespaces fails here.
    const empty = { deny: [], read: [], write: [], noWrite: [] };
    known = bwrap && works(bwrap, [...bwrapArgs(empty), "--", "true"]) ? "bwrap" : "none";
  } else known = "none";
  return known;
}
