import type { FilePreview, TaskInfo } from "@ion/schema";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, sep } from "node:path";
import { UserError } from "../api/errors.js";

/** A process a chat's agent left running (a dev server, a watcher): what the preview's Tasks tab shows. */
export type Task = TaskInfo;

const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve) =>
    // A tool that fails or isn't there answers nothing: the list is then empty, never an error.
    execFile(cmd, args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (_e, out) =>
      resolve(String(out ?? "")),
    ),
  );

/** lsof's NUL-ended fields, each without the line break that ends a process's set. */
const fieldsOf = (out: string) => out.split("\0").map((f) => (f.startsWith("\n") ? f.slice(1) : f));

/**
 * Each process's working folder, from lsof's field output (`p<pid>`, then `n<path>`). Fields end in NUL (`-F0`), so
 * a folder name with a line break can't pass for another field.
 */
async function cwds(pid?: number): Promise<Map<number, string>> {
  const out = await run("lsof", ["-a", ...(pid ? ["-p", String(pid)] : []), "-d", "cwd", "-F0pn"]);
  const map = new Map<number, string>();
  let at = 0;
  for (const field of fieldsOf(out)) {
    if (field.startsWith("p")) at = /^p\d+$/.test(field) ? Number(field.slice(1)) : 0;
    else if (field.startsWith("n") && at) map.set(at, field.slice(1));
  }
  return map;
}

const inside = (dir: string, path: string) => path === dir || path.startsWith(dir + sep);

/** The TCP ports each of these processes listens on. */
async function ports(pids: number[]): Promise<Map<number, number[]>> {
  const out = await run("lsof", ["-a", "-iTCP", "-sTCP:LISTEN", "-P", "-n", "-p", pids.join(","), "-Fpn"]);
  const map = new Map<number, number[]>();
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    const port = line.startsWith("n") ? Number(line.slice(line.lastIndexOf(":") + 1)) : Number.NaN;
    if (pid && Number.isInteger(port)) map.set(pid, [...new Set([...(map.get(pid) ?? []), port])]);
  }
  return map;
}

/** One line of `ps -o pid=,ppid=,etime=,command=`, or null when it isn't one. */
function row(line: string): (Task & { ppid: number }) | null {
  const [pid, ppid, elapsed, ...rest] = line.trim().split(/\s+/);
  if (!pid || !ppid || !elapsed || !rest.length || !/^\d+$/.test(pid)) return null;
  const command = rest.join(" ").slice(0, 500);
  return {
    pid: Number(pid),
    ppid: Number(ppid),
    elapsed,
    command,
    ports: [],
    where: "",
  };
}

/** ion's chat ids (`chat_<uuid>`); anything else is never built into the marker. */
const CHAT_ID = /^[\w-]{1,100}$/;
const uid = () => process.getuid?.() ?? -1;

/** `pid command` lines from ps, by PID. */
function byPid(out: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+) (.*)$/.exec(line);
    if (m) map.set(Number(m[1]), m[2]!);
  }
  return map;
}

/**
 * macOS: your own processes whose environment has `marker` as a whole word. `ps -E` prints the command, then the
 * environment; only what comes after the plain command is read, so an argument can't pass for the marker.
 */
async function markedByPs(marker: string, only?: number): Promise<Set<number>> {
  const which = only ? ["-p", String(only)] : ["-x", "-U", String(uid())];
  const [plain, withEnv] = await Promise.all([
    run("ps", ["-ww", "-o", "pid=,command=", ...which]).then(byPid),
    run("ps", ["-E", "-ww", "-o", "pid=,command=", ...which]).then(byPid),
  ]);
  const pids = new Set<number>();
  for (const [pid, line] of withEnv) {
    const command = plain.get(pid);
    if (command === undefined || !line.startsWith(command)) continue;
    // An environment value with spaces could fake the token, but only from something the chat's agent started (it
    // could set ION_CHAT on anything it starts anyway): the marker finds the chat's processes, it isn't a boundary.
    if (line.slice(command.length).split(/\s+/).includes(marker)) pids.add(pid);
  }
  return pids;
}

/** Linux: your own processes whose environment (`/proc/<pid>/environ`, NUL-separated) has `marker` as an entry. */
export async function markedInProc(marker: string, only?: number, proc = "/proc"): Promise<Set<number>> {
  const names = only ? [String(only)] : await readdir(proc).catch(() => []);
  const pids = new Set<number>();
  await Promise.all(
    names
      .filter((n) => /^\d+$/.test(n))
      .map(async (n) => {
        const st = await stat(join(proc, n)).catch(() => null);
        if (st?.uid !== uid()) return;
        const env = await readFile(join(proc, n, "environ"), "utf8").catch(() => "");
        if (env.split("\0").includes(marker)) pids.add(Number(n));
      }),
  );
  return pids;
}

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash"]);
type Proc = { ppid: number; shell: boolean };

/** Every process's parent, and whether it's a shell (by its executable's name). */
async function processTable(): Promise<Map<number, Proc>> {
  const table = new Map<number, Proc>();
  for (const line of (await run("ps", ["-A", "-o", "pid=,ppid=,comm="])).split("\n")) {
    const [pid, ppid, ...comm] = line.trim().split(/\s+/);
    if (!pid || !ppid || !/^\d+$/.test(pid)) continue;
    const name = basename(comm.join(" ")).replace(/^-/, "");
    table.set(Number(pid), { ppid: Number(ppid), shell: SHELLS.has(name) });
  }
  return table;
}

/**
 * ion's own: the daemon, or below it with no tool call's shell on the way up (the agent CLIs, the processes behind
 * their wrappers, the helpers and MCP servers they start). A shell the daemon starts itself is a launch wrapper (an
 * npm or cmux shim), not a tool call. What a tool call left in the background, its shell gone, is no longer below
 * the daemon at all.
 */
function ionsOwn(pid: number, table: Map<number, Proc>): boolean {
  for (let at = pid, hops = 0; hops < 128; hops++) {
    if (at === process.pid) return true;
    const p = table.get(at);
    if (!p || at <= 1 || (p.shell && p.ppid !== process.pid)) return false;
    at = p.ppid;
  }
  return false;
}

/** Your own processes carrying this chat's marker (`ION_CHAT=<chatId>`), inherited from the agent ion ran for it. */
function markedFor(chatId: string, only?: number): Promise<Set<number>> {
  if (!CHAT_ID.test(chatId)) return Promise.resolve(new Set());
  const marker = `ION_CHAT=${chatId}`;
  return process.platform === "linux" ? markedInProc(marker, only) : markedByPs(marker, only);
}

/**
 * What a chat's agent left running, but not ion's own (the daemon, the agent CLIs it runs and what they run without
 * a tool call's shell; see ionsOwn):
 * processes in the worktree, and processes anywhere carrying the chat's marker (a dev server started elsewhere, a
 * background job whose folder moved). Each says where it runs.
 */
export async function listTasks(worktree: string, chatId: string): Promise<Task[]> {
  const dir = await realpath(worktree).catch(() => worktree);
  const [where, marked, table] = await Promise.all([cwds(), markedFor(chatId), processTable()]);
  const inWorktree = [...where].filter(([, cwd]) => inside(dir, cwd)).map(([pid]) => pid);
  const pids = [...new Set([...inWorktree, ...marked])].filter((pid) => !ionsOwn(pid, table));
  if (!pids.length) return [];
  const rows = (await run("ps", ["-o", "pid=,ppid=,etime=,command=", "-p", pids.join(",")])).split("\n");
  const open = await ports(pids);
  return rows
    .map(row)
    .filter((t): t is Task & { ppid: number } => t !== null)
    .map(({ ppid: _p, ...t }) => ({
      ...t,
      ports: open.get(t.pid) ?? [],
      where: where.get(t.pid) ?? "",
    }));
}

/** Whether this one process is still the chat's: running in its worktree, or carrying its marker. */
async function stillTheChats(worktree: string, chatId: string, pid: number): Promise<boolean> {
  if (ionsOwn(pid, await processTable())) return false;
  const dir = await realpath(worktree).catch(() => worktree);
  const cwd = (await cwds(pid)).get(pid);
  if (cwd && inside(dir, cwd)) return true;
  return (await markedFor(chatId, pid)).has(pid);
}

/** Stops a task, only when it's still the chat's (a PID can be reused). */
export async function stopTask(worktree: string, chatId: string, pid: number): Promise<void> {
  if (!(await listTasks(worktree, chatId)).some((t) => t.pid === pid))
    throw new UserError("That isn't running in this chat");
  // Checked again for this one process right before the signal, so a PID reused meanwhile isn't hit.
  if (!(await stillTheChats(worktree, chatId, pid))) throw new UserError("That isn't running in this chat");
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // it ended on its own meanwhile
  }
}

const MAX = 1_000_000;
const IMAGES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * A plain file's bytes, at most `max`: opened once (never following a link, never waiting on a pipe), then checked
 * and read through that same handle, so nothing can be swapped in between.
 */
async function readPlain(path: string, max: number): Promise<{ bytes: Buffer; size: number }> {
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => {
    throw new UserError("Can't preview this file");
  });
  try {
    const st = await f.stat();
    if (!st.isFile()) throw new UserError("Can't preview this file");
    if (st.size > max) throw new UserError("Too big to preview");
    const buf = Buffer.alloc(max);
    const { bytesRead } = await f.read(buf, 0, max, 0);
    return { bytes: buf.subarray(0, bytesRead), size: st.size };
  } finally {
    await f.close();
  }
}

/** A file in the worktree, never outside it (by path or by link), and at most 1 MB. */
export async function readWorktreeFile(worktree: string, rel: string): Promise<FilePreview> {
  const dir = await realpath(worktree);
  const real = isAbsolute(rel) ? null : await realpath(join(dir, rel)).catch(() => null);
  if (!real || !inside(dir, real)) throw new UserError("That file isn't in this chat");
  const { bytes, size } = await readPlain(real, MAX);
  const ext = extname(real).toLowerCase();
  const image = IMAGES[ext];
  if (image)
    return { path: rel, kind: "image", dataUrl: `data:${image};base64,${bytes.toString("base64")}`, size };
  if (bytes.includes(0)) return { path: rel, kind: "binary", size };
  return {
    path: rel,
    kind: ext === ".html" || ext === ".htm" ? "html" : "text",
    text: bytes.toString("utf8"),
    size,
  };
}
