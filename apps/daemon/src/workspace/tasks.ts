import type { FilePreview, TaskInfo } from "@ion/schema";
import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, sep } from "node:path";
import { UserError } from "../api/errors.js";

/** A process still running in a chat's worktree (a dev server, a watcher): what the preview's Tasks tab shows. */
export type Task = TaskInfo;

const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve) =>
    // A tool that fails or isn't there answers nothing: the list is then empty, never an error.
    execFile(cmd, args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (_e, out) =>
      resolve(String(out ?? "")),
    ),
  );

/** Each process's working folder, from lsof's field output (`p<pid>` then `n<path>`). */
async function cwds(): Promise<Map<number, string>> {
  const out = await run("lsof", ["-a", "-d", "cwd", "-Fpn"]);
  const map = new Map<number, string>();
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) map.set(pid, line.slice(1));
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
  return { pid: Number(pid), ppid: Number(ppid), elapsed, command: rest.join(" ").slice(0, 500), ports: [] };
}

/**
 * What's running in the worktree, but not ion's own (the daemon and the agent CLIs it runs, its direct children):
 * what an agent left behind or started in the background.
 */
export async function listTasks(worktree: string): Promise<Task[]> {
  const dir = await realpath(worktree).catch(() => worktree);
  const pids = [...(await cwds())].filter(([, cwd]) => inside(dir, cwd)).map(([pid]) => pid);
  if (!pids.length) return [];
  const rows = (await run("ps", ["-o", "pid=,ppid=,etime=,command=", "-p", pids.join(",")])).split("\n");
  const open = await ports(pids);
  return rows
    .map(row)
    .filter((t): t is Task & { ppid: number } => t !== null)
    .filter((t) => t.pid !== process.pid && t.ppid !== process.pid)
    .map(({ ppid: _p, ...t }) => ({ ...t, ports: open.get(t.pid) ?? [] }));
}

/** Stops a task, only when it's still running in this worktree (a PID can be reused). */
export async function stopTask(worktree: string, pid: number): Promise<void> {
  if (!(await listTasks(worktree)).some((t) => t.pid === pid))
    throw new UserError("That isn't running in this chat");
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

/** A file in the worktree, never outside it (by path or by link), and at most 1 MB. */
export async function readWorktreeFile(worktree: string, rel: string): Promise<FilePreview> {
  const dir = await realpath(worktree);
  const real = isAbsolute(rel) ? null : await realpath(join(dir, rel)).catch(() => null);
  if (!real || !inside(dir, real)) throw new UserError("That file isn't in this chat");
  const size = (await stat(real)).size;
  if (size > MAX) throw new UserError("Too big to preview");
  const bytes = await readFile(real);
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
