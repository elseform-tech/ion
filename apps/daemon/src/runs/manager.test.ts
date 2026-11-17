import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProject, DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import type { IonEvent } from "@ion/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { UserError } from "../api/errors.js";
import { NeedsService } from "../needs/index.js";
import { type Db, EventStore, openDb } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { allViews } from "../views/index.js";
import { RunManager } from "./manager.js";

process.env.ION_ALLOW_FAKE = "1";

let db: Db;
let store: EventStore;
let needs: NeedsService;
let runs: RunManager;
let repo: string;
let configFile: string;
let dataDir: string;

/** A fresh manager that reads max_runs from the config file. */
const limitTo = (n: number) => {
  const c = addProject(DEFAULT_CONFIG, repo);
  saveUserConfig(configFile, { ...c, resources: { max_runs: n } });
  runs = new RunManager(store, { configFile, dataDir, random: () => 0 }, needs, db);
};

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "ion-runs-"));
  repo = join(home, "repo");
  mkdirSync(repo);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  writeFileSync(join(repo, "README.md"), "# repo\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  configFile = join(home, "config.toml");
  dataDir = join(home, "data");
  saveUserConfig(configFile, addProject(DEFAULT_CONFIG, repo));
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
  needs = new NeedsService(store, db);
  runs = new RunManager(store, { configFile, dataDir, random: () => 0 }, needs, db);
});

async function until<T>(f: () => T | undefined, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
const finished = (runId: string): Promise<IonEvent[]> =>
  until(() => {
    const events = store.read({ runId });
    return events.some((e) => e.type === "run.finished") ? events : undefined;
  });
const openNeed = () => until(() => needs.open()[0]);

const ask = (text: string, extra: object = {}) =>
  runs.ask({ text, projectId: "repo", harness: "fake", ...extra });

describe("RunManager", () => {
  it("creates a chat with its own worktree and stores the run's events in order", async () => {
    const { chatId, runId } = await ask("hello");
    const types = (await finished(runId)).map((e) => e.type);
    expect(types.slice(0, 3)).toEqual(["message.sent", "run.queued", "run.started"]);
    expect(types.at(-1)).toBe("run.finished");
    expect(store.read({ chatId })[0]).toMatchObject({
      type: "chat.created",
      data: { worktree: expect.any(String) },
    });
    expect(existsSync(join(chatsView.worktree(db, chatId)!, "README.md"))).toBe(true);
  });

  it("stores what you asked, and the harness session of each run", async () => {
    const { chatId, runId } = await ask("hello there");
    const events = await finished(runId);
    expect(events[0]).toMatchObject({ type: "message.sent", data: { text: "hello there" } });
    expect(chatsView.session(db, chatId)).toEqual({
      harness: "fake",
      sessionId: expect.stringMatching(/^fake-/),
    });
  });

  it("allows an edit inside the chat's worktree without asking; the file lands there, not in the checkout", async () => {
    const { chatId, runId } = await ask("approve");
    const events = await finished(runId);
    expect(events.find((e) => e.type === "approval.resolved")).toMatchObject({
      data: { decision: "allow", by: "policy" },
    });
    expect(events.some((e) => e.type === "need.raised")).toBe(false);
    expect(existsSync(join(chatsView.worktree(db, chatId)!, "notes.md"))).toBe(true);
    expect(existsSync(join(repo, "notes.md"))).toBe(false);
  });

  it("turns a command into a need, waits, and resumes when you allow it", async () => {
    const { runId } = await ask("shell");
    const need = await openNeed();
    expect(need).toMatchObject({ runId, kind: "command", summary: "Run pnpm test" });
    expect(store.read({ runId }).some((e) => e.type === "run.finished")).toBe(false);
    needs.resolve(need.needId, "allow", "you");
    const events = await finished(runId);
    expect(events.find((e) => e.type === "approval.resolved")).toMatchObject({
      data: { decision: "allow", by: "you" },
    });
    expect(events.find((e) => e.type === "tool.finished")).toMatchObject({ data: { ok: true } });
  });

  it("denies when you deny", async () => {
    const { runId } = await ask("shell");
    needs.resolve((await openNeed()).needId, "deny", "you");
    expect((await finished(runId)).find((e) => e.type === "tool.finished")).toMatchObject({
      data: { ok: false },
    });
  });

  // Regression (security review): the need shows the exact action, and is keyed by it.
  it("shows the exact input on the need", async () => {
    await ask("shell");
    expect((await openNeed()).detail).toMatch(/^command: pnpm test\n/);
  });

  it("asks about an edit outside the worktree", async () => {
    await ask("outside");
    expect(await openNeed()).toMatchObject({ kind: "edit", summary: "Write /etc/ion-test.txt" });
  });

  it("supersedes open needs when ion stops, so they can't resume anything", async () => {
    const { runId } = await ask("shell");
    const need = await openNeed();
    await runs.shutdown();
    expect(store.read({ runId }).find((e) => e.type === "need.resolved")).toMatchObject({
      data: { needId: need.needId, decision: "superseded", by: "daemon" },
    });
    expect(store.read({ runId }).at(-1)).toMatchObject({ type: "run.finished", data: { status: "failed" } });
  });

  it("supersedes open needs when the run is interrupted", async () => {
    const { runId } = await ask("shell");
    await openNeed();
    await runs.interrupt(runId);
    await finished(runId);
    expect(needs.open()).toEqual([]);
  });

  it("archives a chat: removes its worktree, keeps the branch, refuses while running", async () => {
    const { chatId, runId } = await ask("slow");
    await expect(runs.archive(chatId)).rejects.toThrow(new UserError("Stop the chat's run first"));
    await runs.interrupt(runId);
    await finished(runId);
    const wt = chatsView.worktree(db, chatId)!;
    await runs.archive(chatId);
    expect(existsSync(wt)).toBe(false);
    expect(chatsView.list(db)[0]).toMatchObject({ chatId, archived: true });
    await expect(ask("hello", { chatId })).rejects.toThrow(new UserError("That chat is archived"));
  });

  it("queues runs beyond the limit and starts them as slots free up", async () => {
    limitTo(1);
    const a = await ask("slow");
    const b = await ask("hello");
    expect(store.read({ runId: b.runId }).map((e) => e.type)).toEqual(["message.sent", "run.queued"]);
    await runs.interrupt(a.runId);
    const types = (await finished(b.runId)).map((e) => e.type);
    expect(types.slice(0, 3)).toEqual(["message.sent", "run.queued", "run.started"]);
  });

  it("interrupting a queued run finishes it without starting the harness", async () => {
    limitTo(1);
    const a = await ask("slow");
    const b = await ask("hello");
    await runs.interrupt(b.runId);
    expect(store.read({ runId: b.runId }).map((e) => e.type)).toEqual([
      "message.sent",
      "run.queued",
      "run.finished",
    ]);
    expect(store.read({ runId: b.runId }).at(-1)?.data).toEqual({ status: "interrupted" });
    await runs.interrupt(a.runId);
    await finished(a.runId);
  });

  it("retries a transient failure: twice rate-limited, then done", async () => {
    const { runId } = await ask("flaky");
    const events = await finished(runId);
    expect(events.filter((e) => e.type === "run.retrying").map((e) => e.data)).toEqual([
      { attempt: 1, delayS: 0, reason: "Rate limited", effort: null },
      { attempt: 2, delayS: 0, reason: "Rate limited", effort: null },
    ]);
    expect(events.filter((e) => e.type === "run.started")).toHaveLength(3);
    expect(events.filter((e) => e.type === "run.finished")).toHaveLength(1);
    expect(events.at(-1)?.data).toEqual({ status: "done" });
  });

  it("stops after 4 tries of a transient failure, with the last error shown", async () => {
    const { runId } = await ask("overloaded");
    const events = await finished(runId);
    expect(events.filter((e) => e.type === "run.started")).toHaveLength(4);
    expect(events.filter((e) => e.type === "run.retrying")).toHaveLength(3);
    expect(events.at(-2)).toMatchObject({ type: "error", data: { message: "Rate limited" } });
    expect(events.at(-1)?.data).toEqual({ status: "failed" });
  });

  it("retries a real failure once at the next effort, and not above max", async () => {
    const high = await finished((await ask("fail", { effort: "high" })).runId);
    expect(
      high.filter((e) => e.type === "run.started").map((e) => (e.data as { effort: string }).effort),
    ).toEqual(["high", "max"]);
    expect(high.at(-1)?.data).toEqual({ status: "failed" });
    const max = await finished((await ask("fail", { effort: "max" })).runId);
    expect(max.filter((e) => e.type === "run.started")).toHaveLength(1);
  });

  // Final review I3: an interrupt during start used to still send the prompt.
  it("an interrupt while the harness starts ends the run without sending the prompt", async () => {
    process.env.ION_FAKE_START_MS = "150";
    try {
      const { chatId, runId } = await ask("approve");
      await new Promise((r) => setTimeout(r, 40));
      await runs.interrupt(runId);
      const events = await finished(runId);
      expect(events.at(-1)?.data).toEqual({ status: "interrupted" });
      expect(events.some((e) => e.type === "run.started")).toBe(false);
      await new Promise((r) => setTimeout(r, 100));
      expect(existsSync(join(chatsView.worktree(db, chatId)!, "notes.md"))).toBe(false);
    } finally {
      delete process.env.ION_FAKE_START_MS;
    }
  });

  // Final review I5: nothing is stored after a run's end, even when a start fails during shutdown.
  it("stores nothing after run.finished when ion stops during a failing start", async () => {
    process.env.ION_FAKE_START_MS = "100";
    process.env.ION_FAKE_START_FAIL = "1";
    try {
      const { runId } = await ask("hello");
      await new Promise((r) => setTimeout(r, 30));
      await runs.shutdown();
      await new Promise((r) => setTimeout(r, 150));
      expect(store.read({ runId }).at(-1)).toMatchObject({
        type: "run.finished",
        data: { status: "failed" },
      });
    } finally {
      delete process.env.ION_FAKE_START_MS;
      delete process.env.ION_FAKE_START_FAIL;
    }
  });

  // Final review I2 / Review Focus 1: answering a need after a restart says the run stopped.
  it("after a restart, answering the old need says the run stopped", async () => {
    const { chatId, runId } = await ask("shell");
    const need = await openNeed();
    const restarted = new RunManager(store, { configFile, dataDir, random: () => 0 }, needs, db);
    restarted.closeUnfinishedRuns([{ runId, chatId, status: "running" }]);
    expect(() => needs.resolve(need.needId, "allow", "you")).toThrow(new UserError("That run stopped"));
    await runs.shutdown();
  });

  // Final review minor 3: a chat stays in its own project.
  it("keeps a chat in its own project whatever -p says", async () => {
    const { chatId, runId } = await ask("hello");
    await finished(runId);
    const again = await ask("hello", { chatId, projectId: "nope" });
    expect((await finished(again.runId)).at(-1)?.data).toEqual({ status: "done" });
  });

  const said = (events: IonEvent[]) =>
    events.filter((e) => e.type === "message.completed").map((e) => (e.data as { text: string }).text);
  const sessionOf = (events: IonEvent[]) =>
    events.filter((e) => e.type === "run.started").map((e) => (e.data as { sessionId: string }).sessionId);

  it("continues a chat by resuming its session, sending just your message", async () => {
    const first = await ask("echo one");
    const a = await finished(first.runId);
    const second = await ask("echo two", { chatId: first.chatId });
    const b = await finished(second.runId);
    expect(sessionOf(b)).toEqual(sessionOf(a));
    expect(said(b)).toEqual(["echo two"]);
  });

  // Review Focus 1: a session the harness can't resume.
  it("falls back to a new session with the chat's history when the session can't be resumed", async () => {
    const first = await ask("echo one");
    const a = await finished(first.runId);
    process.env.ION_FAKE_RESUME_FAIL = "1";
    try {
      const second = await ask("echo two", { chatId: first.chatId });
      const b = await finished(second.runId);
      expect(sessionOf(b)).not.toEqual(sessionOf(a));
      expect(said(b)[0]).toMatch(
        /^<ion-data source="this chat's earlier messages">\nyou: echo one\nagent: echo one\n<\/ion-data>\n\necho two$/,
      );
      expect(b.some((e) => e.type === "error")).toBe(false);
      expect(b.at(-1)?.data).toEqual({ status: "done" });
    } finally {
      delete process.env.ION_FAKE_RESUME_FAIL;
    }
  });

  it("replays the history when the chat has no session to resume", async () => {
    process.env.ION_FAKE_START_FAIL = "1";
    const first = await ask("echo one");
    await finished(first.runId);
    delete process.env.ION_FAKE_START_FAIL;
    const b = await finished((await ask("echo two", { chatId: first.chatId })).runId);
    expect(said(b)[0]).toMatch(/you: echo one\n<\/ion-data>\n\necho two$/);
  });

  it("resumes the failed try's session when it retries", async () => {
    const events = await finished((await ask("flaky")).runId);
    const ids = sessionOf(events);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
  });

  it("stores a failed run and keeps working", async () => {
    const { runId } = await ask("fail");
    expect((await finished(runId)).at(-1)?.data).toEqual({ status: "failed" });
    const again = await ask("hello");
    expect((await finished(again.runId)).at(-1)?.data).toEqual({ status: "done" });
  });

  it("refuses a second run in a chat that's still running", async () => {
    const { chatId, runId } = await ask("slow");
    await expect(ask("hello", { chatId })).rejects.toThrow("This chat is already running");
    await runs.interrupt(runId);
    expect((await finished(runId)).at(-1)?.data).toEqual({ status: "interrupted" });
  });

  it("runs only one of two concurrent asks on the same chat", async () => {
    const { chatId, runId } = await ask("hello");
    await finished(runId);
    const results = await Promise.allSettled([ask("slow", { chatId }), ask("slow", { chatId })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const ok = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ runId: string }>;
    await runs.interrupt(ok.value.runId);
    await finished(ok.value.runId);
  });

  it("refuses a signed-out harness with the sign-in hint and stores nothing", async () => {
    process.env.ION_FAKE_SIGNED_OUT = "1";
    try {
      await expect(ask("hello")).rejects.toThrow("Fake isn't signed in. Run: ion fake login");
      expect(store.read({})).toHaveLength(0);
    } finally {
      delete process.env.ION_FAKE_SIGNED_OUT;
    }
  });

  it("rejects an unknown project or harness without storing anything", async () => {
    await expect(ask("hello", { projectId: "nope" })).rejects.toThrow(new UserError("Unknown project: nope"));
    await expect(ask("hello", { harness: "nope" })).rejects.toThrow("Unknown harness: nope");
    expect(store.read({})).toHaveLength(0);
  });
});
