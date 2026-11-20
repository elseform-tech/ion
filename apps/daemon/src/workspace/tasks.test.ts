import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ionsOwn, isShell, listTasks, markedInProc, readWorktreeFile, stopTask, whereOf } from "./tasks.js";

// Your home, for these tests: the temp folder the test worktrees are made in (so `where` shows as ~/…).
vi.mock("node:os", async (real) => {
  const os = await real<typeof import("node:os")>();
  const { realpathSync: real2 } = await import("node:fs");
  const homedir = () => real2(os.tmpdir());
  return { ...os, default: { ...os, homedir }, homedir };
});
const home = realpathSync(tmpdir());

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
function leaveFrom(dir: string, chat: string | null): number {
  const server = `'${process.execPath}' -e 'setTimeout(() => {}, 30000)'`;
  const env = { ...process.env };
  delete env.ION_CHAT;
  const out = execFileSync("sh", ["-c", `cd '${dir}' && { ${server} >/dev/null 2>&1 & echo $!; }`], {
    env: chat ? { ...env, ION_CHAT: chat } : env,
  }).toString();
  const pid = Number(out.trim());
  kids.push(pid);
  return pid;
}

/** What the fake agent prints: its PID, a helper it started itself, and what its tool call's shell left behind. */
const AGENT = `
const { spawn, execFileSync } = require("node:child_process");
const idle = ["-e", "setTimeout(() => {}, 30000)"];
const helper = spawn(process.execPath, idle, { stdio: "ignore" });
const cmd = "'" + process.execPath + "' -e 'setTimeout(() => {}, 30000)' >/dev/null 2>&1 & echo $!";
const left = Number(String(execFileSync("sh", ["-c", cmd])).trim());
console.log(JSON.stringify({ agent: process.pid, helper: helper.pid, left }));
setTimeout(() => {}, 30000);
`;

/**
 * An agent as ion runs it, the test process standing in for the daemon: a shell wrapper (like an npm or cmux
 * shim) that runs the agent, in the worktree, with the chat's marker.
 */
async function startAgent(dir: string, chat: string) {
  const file = join(dir, "agent.cjs");
  writeFileSync(file, AGENT);
  const wrapper = spawn("sh", ["-c", `'${process.execPath}' '${file}'; true`], {
    cwd: dir,
    env: { ...process.env, ION_CHAT: chat },
    stdio: ["ignore", "pipe", "ignore"],
  });
  const line = await new Promise<string>((resolve) => wrapper.stdout.once("data", (d) => resolve(String(d))));
  const pids = {
    ...(JSON.parse(line) as { agent: number; helper: number; left: number }),
    wrapper: wrapper.pid!,
  };
  kids.push(pids.left, pids.helper, pids.agent, pids.wrapper);
  return pids;
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
    // Task review, 2026-11-19: the daemon says where, so the desktop doesn't guess from the path: "" in the worktree.
    expect(tasks.find((t) => t.pid === pid)?.where).toBe("");
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
    // Task review, 2026-11-19: elsewhere, with your home shortened to ~.
    expect(task).toMatchObject({ where: `~${elsewhere.slice(home.length)}` });
    expect(task?.command).toContain("setTimeout");
  });

  it("never lists another chat's process, or one of yours outside ion", async () => {
    const wt = worktree();
    const theirs = leaveFrom(worktree(), "c12");
    // Task review, 2026-11-19: node, not /bin/sleep (whose environment macOS hides), so this checks the marker.
    const yours = leaveFrom(worktree(), null);
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

  // Task review, 2026-11-19: the real Codex ran as a grandchild of the daemon (under a bash wrapper), carrying
  // ION_CHAT in the worktree, so it showed as a task and Stop could kill a live run. Below the daemon, only what a
  // tool call's shell started is the chat's; the agent, its wrapper's children and its helpers are ion's own.
  it("never lists the agent's own processes, and can't stop them, but lists what its tool calls left", async () => {
    const wt = worktree();
    const pids = await startAgent(wt, "c1");
    await settle();
    const listed = (await listTasks(wt, "c1")).map((t) => t.pid);
    expect(listed).toContain(pids.left);
    for (const own of [pids.agent, pids.helper, pids.wrapper])
      expect(listed, `pid ${own}`).not.toContain(own);
    await expect(stopTask(wt, "c1", pids.helper)).rejects.toThrow("That isn't running in this chat");
    await expect(stopTask(wt, "c1", pids.agent)).rejects.toThrow("That isn't running in this chat");
  });

  // Task review, 2026-11-19: if `ps -A` fails or times out (no process table), the agent ion runs directly is still
  // ion's own, never listed or stoppable.
  it("keeps the daemon's direct child out even with no process table", () => {
    expect(ionsOwn({ pid: 999_999, ppid: process.pid }, new Map())).toBe(true);
    expect(ionsOwn({ pid: process.pid, ppid: 1 }, new Map())).toBe(true);
    expect(ionsOwn({ pid: 999_999, ppid: 1 }, new Map())).toBe(false);
  });

  // Task review, 2026-11-19: more shells count as a tool call's shell, whatever their case.
  it("knows a tool call's shell by its name", () => {
    for (const name of ["Bash", "/bin/ksh", "-zsh", "mksh", "tcsh", "csh", "nu", "pwsh", "xonsh", "dash"])
      expect(isShell(name), name).toBe(true);
    expect(isShell("/usr/local/bin/node")).toBe(false);
    expect(isShell("codex")).toBe(false);
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

describe("whereOf", () => {
  // Final review, 2026-11-19: when lsof failed for a process its folder was unknown, and it showed as in the worktree.
  it("says unknown (null), not the worktree, when the folder isn't known", () => {
    expect(whereOf("/w", undefined, "/Users/me", "darwin")).toBeNull();
    expect(whereOf("/w", "/w/sub", "/Users/me", "darwin")).toBe("");
  });

  // Tour, 2026-11-19: on macOS a task in /tmp showed as /private/tmp/… (the real path); people expect /tmp/….
  it("shows /tmp and /var for macOS's /private/tmp and /private/var, home as ~", () => {
    // Built from parts: these are paths to show, never folders the test writes to.
    const [ptmp, tmp] = ["/private/tmp", "/tmp"].map((d) => `${d}/site`);
    expect(whereOf("/w", ptmp, "/Users/me", "darwin")).toBe(tmp);
    expect(whereOf("/w", "/private/var/folders/x", "/Users/me", "darwin")).toBe("/var/folders/x");
    expect(whereOf("/w", "/private/tmp", "/Users/me", "darwin")).toBe("/tmp");
    expect(whereOf("/w", "/private/tmpfoo", "/Users/me", "darwin")).toBe("/private/tmpfoo");
    expect(whereOf("/w", ptmp, "/Users/me", "linux")).toBe(ptmp);
    expect(whereOf("/w", "/Users/me/dev/site", "/Users/me", "darwin")).toBe("~/dev/site");
  });
});
