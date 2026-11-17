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
  const configFile = join(home, "config.toml");
  saveUserConfig(configFile, addProject(DEFAULT_CONFIG, repo));
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
  needs = new NeedsService(store, db);
  runs = new RunManager(store, { configFile, dataDir: join(home, "data") }, needs, db);
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
    expect(types[0]).toBe("run.started");
    expect(types.at(-1)).toBe("run.finished");
    expect(store.read({ chatId })[0]).toMatchObject({
      type: "chat.created",
      data: { worktree: expect.any(String) },
    });
    expect(existsSync(join(chatsView.worktree(db, chatId)!, "README.md"))).toBe(true);
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
    expect((await openNeed()).detail).toContain('"command":"pnpm test"');
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
