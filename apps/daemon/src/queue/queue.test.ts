import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProject, DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import { EV } from "@ion/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UserError } from "../api/errors.js";
import { Decisions } from "../decisions/index.js";
import { NeedsService } from "../needs/index.js";
import { RunManager } from "../runs/manager.js";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { PromptQueue, type QueueDeps } from "./index.js";

// The user, 2026-11-19: "include hotkey for queuing prompt request so that user can queue request (with push now icon,
// edit icon, remove icon)" and "even for ions, maybe?". The daemon keeps each chat's and each ion's queue as events,
// and sends the next one when the work ends.

process.env.ION_ALLOW_FAKE = "1";

let db: Db;
let store: EventStore;
let runs: RunManager;
let queue: PromptQueue;
let configFile: string;
let dataDir: string;
let made: RunManager[] = [];
let needs: NeedsService;
let decisions: Decisions;

const fake = { harness: "fake" } as const;

function manager(): RunManager {
  const r = new RunManager(store, { configFile, dataDir, random: () => 0 }, needs, db);
  made.push(r);
  return r;
}

/** An ion that thinks one turn at a time; each turn waits until the test ends it. */
function fakeIons() {
  const known = new Set(["chief"]);
  const heard: string[] = [];
  const ends: ((ionId: string) => void)[] = [];
  const open: (() => void)[] = [];
  const stopped: string[] = [];
  const end = (ionId: string) => {
    open.shift()?.();
    for (const fn of ends) fn(ionId);
  };
  const ions: QueueDeps["ions"] = {
    knows: (id) => known.has(id),
    message: (_id, text) => {
      heard.push(text);
      return new Promise<void>((r) => open.push(r));
    },
    busy: () => open.length > 0,
    stopTurn: (id) => {
      stopped.push(id);
      end(id);
      return true;
    },
    onTurnEnd: (fn) => void ends.push(fn),
  };
  return { ions, heard, end, stopped, known };
}

function makeQueue(ions = fakeIons().ions): PromptQueue {
  queue = new PromptQueue({
    store,
    db,
    chats: {
      ask: (a) => runs.ask({ ...fake, ...a }),
      busy: (id) => runs.busy(id),
      stop: (id) => runs.stopChat(id),
      onEnded: (fn) => runs.onEnded(fn),
      answersWaiting: (id) => decisions.hasWaiting(id),
      dropQuestions: (id) => needs.supersedeChat(id),
    },
    ions,
  });
  return queue;
}

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "ion-queue-"));
  const repo = join(home, "repo");
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
  runs = manager();
  decisions = new Decisions({
    ...{ store, db, needs },
    followUp: async (chatId, m) => (await runs.ask({ chatId, text: m.text, ...fake })).runId,
  });
  makeQueue();
});

afterEach(async () => {
  for (const r of made) await r.shutdown();
  made = [];
});

async function until<T>(f: () => T | undefined | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** What the chat was sent, in order (the first is the run that was going). */
const sent = (chatId: string) =>
  store
    .read({ chatId })
    .filter((e) => e.type === EV.messageSent)
    .map((e) => String((e.data as { text: string }).text));

/** A chat whose agent is working (the fake agent's `slow`, 30 s unless stopped). */
async function working(): Promise<{ chatId: string; runId: string }> {
  const r = await runs.ask({ text: "slow", projectId: "repo", ...fake });
  await until(() => store.read({ runId: r.runId }).some((e) => e.type === EV.runStarted));
  return r;
}

const finishedAll = (chatId: string) =>
  until(() => {
    const ends = store.read({ chatId }).filter((e) => e.type === EV.runFinished).length;
    return !runs.busy(chatId) && ends === sent(chatId).length && ends;
  });

describe("the prompt queue", () => {
  it("queues while a run goes, and sends the next when it finishes", async () => {
    const { chatId, runId } = await working();
    queue.add({ chatId }, "hello one", fake);
    queue.add({ chatId }, "hello two", fake);
    expect(queue.list({ chatId }).map((q) => q.text)).toEqual(["hello one", "hello two"]);
    expect(sent(chatId)).toEqual(["slow"]);
    await runs.interrupt(runId);
    await until(() => sent(chatId).length === 3);
    expect(sent(chatId)).toEqual(["slow", "hello one", "hello two"]);
    await finishedAll(chatId);
    expect(queue.list({ chatId })).toEqual([]);
  });

  // Review Focus 4: Send now with three waiting → that one goes next, the others keep their order.
  it("keeps order; Send now goes next and interrupts the run", async () => {
    const { chatId, runId } = await working();
    queue.add({ chatId }, "hello one", fake);
    queue.add({ chatId }, "hello two", fake);
    const third = queue.add({ chatId }, "hello three", fake);
    await queue.sendNow(third);
    await finishedAll(chatId);
    expect(sent(chatId)).toEqual(["slow", "hello three", "hello one", "hello two"]);
    expect(store.read({ runId }).at(-1)?.data).toEqual({ status: "interrupted" });
  });

  // Review Focus 1: a run fails while messages wait → the next one is still sent.
  it("a failed run still sends the next", async () => {
    const { chatId, runId } = await working();
    queue.add({ chatId }, "fail now", fake);
    queue.add({ chatId }, "hello after", fake);
    await runs.interrupt(runId);
    await finishedAll(chatId);
    expect(sent(chatId)).toEqual(["slow", "fail now", "hello after"]);
    const statuses = store
      .read({ chatId })
      .filter((e) => e.type === EV.runFinished)
      .map((e) => (e.data as { status: string }).status);
    expect(statuses).toEqual(["interrupted", "failed", "done"]);
  });

  // Review Focus 2: ion stops and starts again with messages waiting → they're still listed and go out.
  it("survives a restart", async () => {
    const { chatId } = await working();
    queue.add({ chatId }, "hello one", { harness: "fake", effort: "high", access: "full" });
    queue.add({ chatId }, "hello two", fake);
    await runs.shutdown();
    // A new daemon on the same events: the views rebuild from the log, the run ion stopped is closed.
    store = new EventStore(db, allViews);
    store.rebuildViews();
    needs = new NeedsService(store, db);
    runs = manager();
    makeQueue();
    expect(queue.list({ chatId })).toMatchObject([
      { text: "hello one", brain: { harness: "fake", effort: "high", access: "full" } },
      { text: "hello two", brain: fake },
    ]);
    queue.resume();
    await finishedAll(chatId);
    expect(sent(chatId)).toEqual(["slow", "hello one", "hello two"]);
  });

  // Review Focus 3: Edit while it's being sent → the box gets the text back only if it wasn't sent.
  it("take returns the text and removes it, or refuses once sent", async () => {
    const { chatId, runId } = await working();
    const one = queue.add({ chatId }, "hello one", fake);
    const two = queue.add({ chatId }, "hello two", fake);
    expect(queue.take(two)).toEqual({ text: "hello two" });
    expect(queue.list({ chatId }).map((q) => q.queueId)).toEqual([one]);
    await runs.interrupt(runId);
    // While it's being sent (the run starting), and after, it's no longer yours to edit.
    await until(() => !queue.list({ chatId }).length);
    expect(() => queue.take(one)).toThrow(new UserError("Already sent"));
    await finishedAll(chatId);
    expect(sent(chatId)).toEqual(["slow", "hello one"]);
    expect(() => queue.take(two)).toThrow(UserError);
  });

  it("at most 10", async () => {
    const { chatId } = await working();
    for (let i = 0; i < 10; i++) queue.add({ chatId }, `hello ${i}`, fake);
    expect(() => queue.add({ chatId }, "hello 11", fake)).toThrow(new UserError("That's 10 waiting already"));
    expect(queue.list({ chatId })).toHaveLength(10);
  });

  // Review Focus 5: a chat archived with messages waiting → its queue is cleared.
  it("archiving a chat clears its queue", async () => {
    const { chatId } = await working();
    queue.add({ chatId }, "hello one", fake);
    queue.add({ chatId }, "hello two", fake);
    // ion stopped with them waiting; started again, the chat is archived before they go out.
    await runs.shutdown();
    runs = manager();
    makeQueue();
    await runs.archive(chatId);
    expect(queue.list({ chatId })).toEqual([]);
    expect(store.read({ chatId }).filter((e) => e.type === EV.queueRemoved)).toHaveLength(2);
    expect(sent(chatId)).toEqual(["slow"]);
    expect(() => queue.add({ chatId }, "hello three", fake)).toThrow(new UserError("That chat is archived"));
  });

  it("an ion's queue goes out turn by turn", async () => {
    const ion = fakeIons();
    makeQueue(ion.ions);
    // ion chief is thinking about your first message.
    void ion.ions.message("chief", "first");
    queue.add({ ionId: "chief" }, "second", {});
    const third = queue.add({ ionId: "chief" }, "third", {});
    queue.add({ ionId: "chief" }, "fourth", {});
    expect(ion.heard).toEqual(["first"]);
    ion.end("chief");
    await until(() => ion.heard.length === 2);
    expect(ion.heard).toEqual(["first", "second"]);
    expect(queue.list({ ionId: "chief" }).map((q) => q.text)).toEqual(["third", "fourth"]);
    // Send now stops the ion's turn; that one goes next.
    await queue.sendNow(queue.list({ ionId: "chief" }).at(-1)!.queueId);
    expect(ion.stopped).toEqual(["chief"]);
    await until(() => ion.heard.length === 3);
    ion.end("chief");
    await until(() => ion.heard.length === 4);
    expect(ion.heard).toEqual(["first", "second", "fourth", "third"]);
    expect(queue.list({ ionId: "chief" })).toEqual([]);
    expect(() => queue.take(third)).toThrow(new UserError("Already sent"));
    expect(() => queue.add({ ionId: "nobody" }, "hi", {})).toThrow(UserError);
  });

  // Task review, 2026-11-19: a run that ends by asking you a question got the queued message as its "answer", and
  // your real answer waited behind it. The queue holds while a question is open, and your answer goes first.
  it("a run that ends by asking keeps the queue until answered, and the answer goes before the queued message", async () => {
    const { chatId, runId } = await working();
    const needId = needs.raiseAsk({
      chatId,
      runId,
      question: "Which one?",
      choices: [
        { label: "Alpha", consequence: "a" },
        { label: "Beta", consequence: "b" },
      ],
    });
    queue.add({ chatId }, "hello queued", fake);
    await runs.interrupt(runId);
    await new Promise((r) => setTimeout(r, 200));
    expect(sent(chatId)).toEqual(["slow"]);
    expect(queue.list({ chatId })).toHaveLength(1);
    await decisions.answer(needId, 1);
    await until(() => sent(chatId).length === 3);
    await finishedAll(chatId);
    expect(sent(chatId)[1]).toContain("Alpha");
    expect(sent(chatId)[2]).toBe("hello queued");
  });

  // Task review, 2026-11-19: a send that failed (the agent signed out) stalled the queue silently. It says why, and
  // the queue waits until you send it now, edit it or remove it.
  it("a send that fails says why and holds the queue until you deal with it", async () => {
    const { chatId, runId } = await working();
    await runs.interrupt(runId);
    await finishedAll(chatId);
    process.env.ION_FAKE_SIGNED_OUT = "1";
    try {
      // A model the agent wasn't checked for yet: it's asked again, and it's signed out.
      const failed = queue.add({ chatId }, "hello one", { harness: "fake", model: "other" });
      const why = await until(() => queue.list({ chatId })[0]?.why);
      expect(why).toBe("Fake isn't signed in. Run: ion fake login");
      expect(store.read({ chatId }).some((e) => e.type === EV.queueFailed)).toBe(true);
      delete process.env.ION_FAKE_SIGNED_OUT;
      queue.add({ chatId }, "hello two", fake);
      await new Promise((r) => setTimeout(r, 200));
      expect(sent(chatId)).toEqual(["slow"]);
      queue.remove(failed);
      await until(() => sent(chatId).length === 2);
      await finishedAll(chatId);
      expect(sent(chatId)).toEqual(["slow", "hello two"]);
    } finally {
      delete process.env.ION_FAKE_SIGNED_OUT;
    }
  });

  // Task review, 2026-11-19: Send now while a queued message was still being sent (its run not started yet) didn't
  // stop anything, so the picked one waited behind a 30-second run.
  it("Send now while one is being sent stops it once it starts, and goes next", async () => {
    const { chatId, runId } = await working();
    await runs.interrupt(runId);
    await finishedAll(chatId);
    queue.add({ chatId }, "slow again", fake);
    const two = queue.add({ chatId }, "hello two", fake);
    await queue.sendNow(two);
    await until(() => sent(chatId).length === 3, 10_000);
    await finishedAll(chatId);
    expect(sent(chatId)).toEqual(["slow", "slow again", "hello two"]);
    const statuses = store
      .read({ chatId })
      .filter((e) => e.type === EV.runFinished)
      .map((e) => (e.data as { status: string }).status);
    expect(statuses).toEqual(["interrupted", "interrupted", "done"]);
  });

  // Task review, 2026-11-19: an ion whose project was removed kept its queue, and the next one was lost silently.
  it("an ion that's gone has its queue cleared, not sent", async () => {
    const ion = fakeIons();
    makeQueue(ion.ions);
    ion.known.add("storefront");
    void ion.ions.message("storefront", "first");
    queue.add({ ionId: "storefront" }, "second", {});
    ion.known.delete("storefront");
    ion.end("storefront");
    await new Promise((r) => setTimeout(r, 50));
    expect(ion.heard).toEqual(["first"]);
    expect(queue.list({ ionId: "storefront" })).toEqual([]);
    expect(store.read({ chatId: "ion:storefront" }).filter((e) => e.type === EV.queueRemoved)).toHaveLength(
      1,
    );
    queue.add({ ionId: "chief" }, "x", {});
    queue.clear({ ionId: "chief" });
    expect(queue.list({ ionId: "chief" })).toEqual([]);
  });
});
