import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listTasks, markedInProc, readWorktreeFile, stopTask } from "./tasks.js";

const kids: number[] = [];
afterEach(() => {
  for (const pid of kids.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
});

/** A process left running in `dir`, as an agent's shell leaves a dev server: backgrounded, so not ion's child. */
function leave(dir: string): number {
  const out = execFileSync("sh", ["-c", "sleep 30 >/dev/null 2>&1 & echo $!"], { cwd: dir }).toString();
  const pid = Number(out.trim());
  kids.push(pid);
  return pid;
}

const worktree = () => realpathSync(mkdtempSync(join(tmpdir(), "ion-wt-")));

/**
 * A background process an agent's tool call left in `dir` (`cd dir && server &`), its environment carrying the
 * agent's `ION_CHAT`. It's node, not /bin/sleep: macOS hides the environment of its own system binaries.
 */
function leaveFrom(dir: string, chat: string): number {
  const server = `'${process.execPath}' -e 'setTimeout(() => {}, 30000)'`;
  const out = execFileSync("sh", ["-c", `cd '${dir}' && { ${server} >/dev/null 2>&1 & echo $!; }`], {
    env: { ...process.env, ION_CHAT: chat },
  }).toString();
  const pid = Number(out.trim());
  kids.push(pid);
  return pid;
}

// The user, 2026-11-18: a preview of the workspace, with background tasks and their PIDs.
describe("background tasks in a worktree", () => {
  it("lists what's still running in the worktree, with its PID, and nothing from elsewhere", async () => {
    const wt = worktree();
    const pid = leave(wt);
    const other = leave(worktree());
    await new Promise((r) => setTimeout(r, 200));
    const tasks = await listTasks(wt, "c1");
    expect(tasks.map((t) => t.pid)).toContain(pid);
    expect(tasks.map((t) => t.pid)).not.toContain(other);
    expect(tasks.find((t) => t.pid === pid)?.command).toContain("sleep 30");
  });

  it("stops a task in the worktree, and refuses one that isn't", async () => {
    const wt = worktree();
    const pid = leave(wt);
    const other = leave(worktree());
    await new Promise((r) => setTimeout(r, 200));
    await expect(stopTask(wt, "c1", other)).rejects.toThrow("That isn't running in this chat");
    await stopTask(wt, "c1", pid);
    await new Promise((r) => setTimeout(r, 300));
    expect((await listTasks(wt, "c1")).map((t) => t.pid)).not.toContain(pid);
  });
});

// The user, 2026-11-19: the workspace lists every process a chat's tool calls left running, background ones
// included, wherever they run (`cd /tmp/x && npm run dev &`), found by the ION_CHAT its agent's environment carries.
describe("a chat's processes, wherever they run", () => {
  const settle = () => new Promise((r) => setTimeout(r, 400));

  it("lists a background process started elsewhere by the chat's agent, and where it runs", async () => {
    const wt = worktree();
    const elsewhere = worktree();
    const pid = leaveFrom(elsewhere, "c1");
    await settle();
    const task = (await listTasks(wt, "c1")).find((t) => t.pid === pid);
    expect(task).toMatchObject({ where: elsewhere });
    expect(task?.command).toContain("setTimeout");
  });

  it("never lists another chat's process, or one of yours outside ion", async () => {
    const wt = worktree();
    const theirs = leaveFrom(worktree(), "c12");
    const yours = leave(worktree());
    await settle();
    const pids = (await listTasks(wt, "c1")).map((t) => t.pid);
    expect(pids).not.toContain(theirs);
    expect(pids).not.toContain(yours);
    // The marker counts only in the environment, never as an argument.
    const named = execFileSync(
      "sh",
      ["-c", `'${process.execPath}' -e 'setTimeout(()=>{},30000)' ION_CHAT=c1 >/dev/null 2>&1 & echo $!`],
      { cwd: worktree() },
    );
    kids.push(Number(String(named).trim()));
    await settle();
    expect((await listTasks(wt, "c1")).map((t) => t.pid)).not.toContain(Number(String(named).trim()));
    // A chat id that isn't one matches nothing (it's never built into a pattern).
    expect(await listTasks(wt, "c1 ION_CHAT=c12")).toEqual([]);
  });

  it("stops one, and refuses a PID that isn't the chat's", async () => {
    const wt = worktree();
    const pid = leaveFrom(worktree(), "c1");
    const theirs = leaveFrom(worktree(), "c2");
    await settle();
    await expect(stopTask(wt, "c1", theirs)).rejects.toThrow("That isn't running in this chat");
    await stopTask(wt, "c1", pid);
    await settle();
    expect((await listTasks(wt, "c1")).map((t) => t.pid)).not.toContain(pid);
    expect((await listTasks(wt, "c2")).map((t) => t.pid)).toContain(theirs);
  });

  // Plan 15 review focus 5: the task ended and its PID went to another program; Stop refuses it.
  it("refuses a PID that's gone", async () => {
    await expect(stopTask(worktree(), "c1", 2 ** 22 + 7)).rejects.toThrow("That isn't running in this chat");
  });

  // Linux has no `ps -E`: the environment is read from /proc, your own processes only, the marker as a whole entry.
  it("reads the marker from /proc on Linux, as a whole entry", async () => {
    const proc = worktree();
    const env = (pid: number, vars: string[]) => {
      mkdirSync(join(proc, String(pid)));
      writeFileSync(join(proc, String(pid), "environ"), vars.join("\0") + "\0");
    };
    env(11, ["PATH=/bin", "ION_CHAT=c1"]);
    env(12, ["ION_CHAT=c12"]);
    env(13, ["X=ION_CHAT=c1"]);
    mkdirSync(join(proc, "self"));
    expect([...(await markedInProc("ION_CHAT=c1", undefined, proc))]).toEqual([11]);
    expect([...(await markedInProc("ION_CHAT=c1", 12, proc))]).toEqual([]);
  });
});

describe("reading a worktree's file for the preview", () => {
  it("reads text, HTML and images, by kind", async () => {
    const wt = worktree();
    writeFileSync(join(wt, "notes.md"), "# Hi\n");
    writeFileSync(join(wt, "page.html"), "<h1>Hi</h1>");
    writeFileSync(join(wt, "dot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(await readWorktreeFile(wt, "notes.md")).toMatchObject({ kind: "text", text: "# Hi\n" });
    expect(await readWorktreeFile(wt, "page.html")).toMatchObject({ kind: "html", text: "<h1>Hi</h1>" });
    expect((await readWorktreeFile(wt, "dot.png")).dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it("never reads outside the worktree, by path or by link", async () => {
    const wt = worktree();
    const outside = worktree();
    writeFileSync(join(outside, "secret"), "no");
    mkdirSync(join(wt, "sub"));
    symlinkSync(join(outside, "secret"), join(wt, "sub", "link"));
    await expect(readWorktreeFile(wt, "../secret")).rejects.toThrow("That file isn't in this chat");
    await expect(readWorktreeFile(wt, join(outside, "secret"))).rejects.toThrow(
      "That file isn't in this chat",
    );
    await expect(readWorktreeFile(wt, "sub/link")).rejects.toThrow("That file isn't in this chat");
  });

  it("says a file is too big to preview, past 1 MB", async () => {
    const wt = worktree();
    writeFileSync(join(wt, "big.txt"), "x".repeat(1_100_000));
    await expect(readWorktreeFile(wt, "big.txt")).rejects.toThrow("Too big to preview");
  });
  // Security review, 2026-11-19: only a plain file is read (never a FIFO, device or folder), at most 1 MB.
  it("previews only plain files", async () => {
    const wt = worktree();
    mkdirSync(join(wt, "dir"));
    execFileSync("mkfifo", [join(wt, "pipe")]);
    await expect(readWorktreeFile(wt, "dir")).rejects.toThrow("Can't preview this file");
    await expect(readWorktreeFile(wt, "pipe")).rejects.toThrow("Can't preview this file");
  });
});

// Security review, 2026-11-19: a folder name with a line break can't make another process look like it's in the
// worktree (lsof's output is read NUL-separated).
describe("a worktree whose name has a line break", () => {
  it("still lists only what's really in it", async () => {
    const base = worktree();
    const odd = join(base, "a\np99999\nn" + base);
    mkdirSync(odd, { recursive: true });
    const pid = leave(odd);
    const other = leave(worktree());
    await new Promise((r) => setTimeout(r, 200));
    const tasks = (await listTasks(base, "c1")).map((t) => t.pid);
    expect(tasks).toContain(pid);
    expect(tasks).not.toContain(other);
    expect(tasks).not.toContain(99999);
  });
});
