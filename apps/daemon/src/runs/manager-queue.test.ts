import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProject, DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import type { IonEvent } from "@ion/schema";
import { beforeEach, expect, it } from "vitest";
import { NeedsService } from "../needs/index.js";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { RunManager } from "./manager.js";

process.env.ION_ALLOW_FAKE = "1";

let db: Db;
let store: EventStore;
let runs: RunManager;
let repo: string;
let configFile: string;
let dataDir: string;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "ion-run-queue-"));
  repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const who = ["-c", "user.email=t@example.com", "-c", "user.name=T"];
  execFileSync("git", ["-C", repo, ...who, "commit", "-q", "--allow-empty", "-m", "init"]);
  configFile = join(dir, "config.toml");
  dataDir = join(dir, "data");
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
});

/** A fresh manager that reads max_runs from the config file. */
const limitTo = (n: number) => {
  saveUserConfig(configFile, { ...addProject(DEFAULT_CONFIG, repo), resources: { max_runs: n } });
  runs = new RunManager(store, { configFile, dataDir }, new NeedsService(store, db), db);
};

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

/** Your own chat. */
const ask = (text: string) => runs.ask({ text, projectId: "repo", harness: "fake" });
/** A chat an ion starts (its threads, routines): these wait for a slot. */
const askIon = (text: string) => runs.ask({ text, projectId: "repo", harness: "fake" }, { by: "ion" });
const typesOf = (runId: string) => store.read({ runId }).map((e) => e.type);

// The user, 2026-11-22: your own chats never wait; the limit ("Chats ion runs at once") is for ion's own work.
it("your chat starts even when ion's slots are full", async () => {
  limitTo(1);
  const a = await askIon("slow");
  const mine = await ask("hello");
  expect((await finished(mine.runId)).map((e) => e.type).slice(0, 3)).toEqual([
    "message.sent",
    "run.queued",
    "run.started",
  ]);
  expect(store.read({ runId: mine.runId }).find((e) => e.type === "run.queued")?.data).toEqual({
    access: "auto",
  });
  await runs.interrupt(a.runId);
  await finished(a.runId);
});

// The user, 2026-11-22: chats ions start and routines (an ion's threads) wait for a slot, and say why; your own
// running chats don't take one.
it("ion-started chats and routines wait for a slot", async () => {
  limitTo(1);
  const a = await askIon("slow");
  const mine = await ask("slow");
  const b = await askIon("hello");
  await new Promise((r) => setTimeout(r, 50));
  expect(typesOf(b.runId)).toEqual(["message.sent", "run.queued"]);
  expect(store.read({ runId: b.runId }).find((e) => e.type === "run.queued")?.data).toEqual({
    access: "auto",
    waiting: "Waiting — 1 ion chat running",
  });
  await runs.interrupt(mine.runId);
  await finished(mine.runId);
  await new Promise((r) => setTimeout(r, 50));
  expect(typesOf(b.runId)).toEqual(["message.sent", "run.queued"]);
  await runs.interrupt(a.runId);
  expect((await finished(b.runId)).map((e) => e.type).slice(0, 3)).toContain("run.started");
});

it("queues runs beyond the limit and starts them as slots free up", async () => {
  limitTo(1);
  const a = await askIon("slow");
  const b = await askIon("hello");
  expect(store.read({ runId: b.runId }).map((e) => e.type)).toEqual(["message.sent", "run.queued"]);
  await runs.interrupt(a.runId);
  const types = (await finished(b.runId)).map((e) => e.type);
  expect(types.slice(0, 3)).toEqual(["message.sent", "run.queued", "run.started"]);
});

// Task review, 2026-11-20: the limit was read from config.toml on every pump; it's read when the manager is made
// and when Settings changes it (limitChanged).
it("reads the limit once, and again when it changes", async () => {
  limitTo(1);
  saveUserConfig(configFile, { ...addProject(DEFAULT_CONFIG, repo), resources: { max_runs: 3 } });
  const a = await askIon("slow");
  const b = await askIon("slow");
  await new Promise((r) => setTimeout(r, 100));
  expect(store.read({ runId: b.runId }).map((e) => e.type)).toEqual(["message.sent", "run.queued"]);
  runs.limitChanged();
  await until(() => store.read({ runId: b.runId }).find((e) => e.type === "run.started"));
  await runs.interrupt(a.runId);
  await runs.interrupt(b.runId);
  await finished(a.runId);
  await finished(b.runId);
});

// Task review, 2026-11-20: lowering max_runs only holds back new starts; chats already running carry on.
it("lowering the limit never stops running chats", async () => {
  limitTo(2);
  const a = await askIon("slow");
  const b = await askIon("slow");
  const c = await askIon("slow");
  await until(() => store.read({ runId: b.runId }).find((e) => e.type === "run.started"));
  saveUserConfig(configFile, { ...addProject(DEFAULT_CONFIG, repo), resources: { max_runs: 1 } });
  runs.limitChanged();
  await new Promise((r) => setTimeout(r, 50));
  for (const r of [a, b])
    expect(store.read({ runId: r.runId }).some((e) => e.type === "run.finished")).toBe(false);
  expect(store.read({ runId: c.runId }).some((e) => e.type === "run.started")).toBe(false);
  for (const r of [a, b, c]) await runs.interrupt(r.runId);
  for (const r of [a, b, c]) await finished(r.runId);
});

it("interrupting a queued run finishes it without starting the harness", async () => {
  limitTo(1);
  const a = await askIon("slow");
  const b = await askIon("hello");
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

// Review of bf69fe1, 2026-11-23: a handoff (or a wait going on) inside an ion's thread skipped the limit; it's ion's
// own work, so it waits for a slot. One in your own chat still starts at once.
it("a handoff in an ion thread waits while slots are full; one in your own chat doesn't", async () => {
  limitTo(1);
  const thread = await askIon("hello");
  await finished(thread.runId);
  const mine = await ask("hello");
  await finished(mine.runId);
  const hold = await askIon("slow");
  const brief = { text: "ion's brief", harness: "fake" };
  const inThread = await runs.ask({ ...brief, chatId: thread.chatId }, { handoff: true });
  const inMine = await runs.ask({ ...brief, chatId: mine.chatId }, { handoff: true });
  await finished(inMine.runId);
  await new Promise((r) => setTimeout(r, 50));
  expect(typesOf(inThread.runId)).toEqual(["message.sent", "run.queued"]);
  expect(store.read({ runId: inThread.runId }).find((e) => e.type === "run.queued")?.data).toEqual({
    access: "auto",
    waiting: "Waiting — 1 ion chat running",
  });
  await runs.interrupt(hold.runId);
  expect((await finished(inThread.runId)).map((e) => e.type)).toContain("run.started");
});

// Task 3 re-review, 2026-11-23: "Pick up where you left off" (ion chief's resume of a stalled chat) in an ion's
// thread skipped "Chats ion runs at once"; it counts like any run ion starts. In your own chat it still starts.
it("a resume in an ion thread waits while slots are full; one in your own chat doesn't", async () => {
  limitTo(1);
  const thread = await askIon("hello");
  await finished(thread.runId);
  const mine = await ask("hello");
  await finished(mine.runId);
  const hold = await askIon("slow");
  const resume = { text: "Pick up where you left off.", harness: "fake" };
  const inThread = await runs.ask({ ...resume, chatId: thread.chatId }, { resume: true });
  const inMine = await runs.ask({ ...resume, chatId: mine.chatId }, { resume: true });
  await finished(inMine.runId);
  await new Promise((r) => setTimeout(r, 50));
  expect(typesOf(inThread.runId)).toEqual(["message.sent", "run.queued"]);
  await runs.interrupt(hold.runId);
  expect((await finished(inThread.runId)).map((e) => e.type)).toContain("run.started");
});
