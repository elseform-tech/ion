import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type RoutineEntry, saveUserConfig } from "@ion/config";
import { EV, type MemoryScope } from "@ion/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryFiles } from "../memory/index.js";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { Notifier } from "./index.js";

// The user, 2026-11-19: "also build the settings as well … notifications …"; the lab's Timing: a daily briefing
// from ion chief at 8:30 — what finished, what needs you, today's routines. Built from views, no model.

let db: Db;
let store: EventStore;
let configFile: string;
let stops: (() => void)[] = [];
let n = 0;

const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m);

const morning: RoutineEntry = {
  id: "morning",
  name: "Morning check",
  when: "daily 09:00",
  text: "Run the tests.",
  on: true,
};

function save(routines: RoutineEntry[] = []) {
  saveUserConfig(configFile, {
    ...DEFAULT_CONFIG,
    notifications: {
      briefing: { on: true, at: "08:30" },
      quiet: { on: true, from: "22:00", to: "08:00" },
    },
    projects: [{ id: "storefront", name: "Storefront", path: "/p/storefront", starred: false, routines }],
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at(19, 7));
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
  configFile = join(mkdtempSync(join(tmpdir(), "ion-briefing-")), "config.toml");
  save();
});

afterEach(() => {
  for (const s of stops) s();
  stops = [];
  vi.useRealTimers();
});

function boot(memory?: MemoryFiles): void {
  const x = new Notifier({ store, db, configFile, ...(memory ? { memory } : {}) });
  x.start();
  stops.push(() => x.stop());
}

function restart(): void {
  for (const s of stops) s();
  stops = [];
  boot();
}

function chat(chatId: string, title: string): void {
  const data = { title, projectId: "storefront" };
  store.append({ chatId, runId: null, origin: "daemon", type: EV.chatCreated, data });
}

function finished(chatId: string): void {
  store.append({
    chatId,
    runId: `r${++n}`,
    origin: "daemon",
    type: EV.runFinished,
    data: { status: "done" },
  });
}

function need(chatId: string, summary: string): void {
  const needId = `n${++n}`;
  store.append({
    chatId,
    runId: "r0",
    origin: "daemon",
    type: EV.needRaised,
    data: {
      needId,
      requestId: `ask_${needId}`,
      kind: "ask",
      summary,
      detail: null,
      dedupeKey: `ask:${needId}`,
    },
  });
}

const briefings = () =>
  store
    .read({ chatId: "ion:chief" })
    .filter((e) => e.type === EV.ionSaid)
    .map((e) => (e.data as { text: string }).text);

const posted = () =>
  store
    .read({})
    .filter((e) => e.type === EV.briefingPosted)
    .map((e) => (e.data as { day: string }).day);

const until = (t: Date) => vi.advanceTimersByTimeAsync(t.getTime() - Date.now());

describe("the daily briefing", () => {
  it("the briefing posts once a day at its time, with what finished, what needs you and today's routines", async () => {
    save([morning]);
    chat("c1", "Fix the cart");
    chat("c2", "Pick a database");
    finished("c1");
    need("c2", "Postgres or SQLite?");
    boot();
    await until(at(19, 8, 29));
    expect(briefings()).toEqual([]);
    await until(at(19, 8, 30));
    expect(briefings()).toHaveLength(1);
    const text = briefings()[0]!;
    expect(text).toContain("Storefront");
    expect(text).toContain("Fix the cart");
    expect(text).toContain("1 thing needs you");
    expect(text).toContain("Postgres or SQLite?");
    expect(text).toContain("Morning check at 9:00");
    expect(text).not.toMatch(/(^|\n)#/); // plain sentences, no headings
    expect(posted()).toEqual(["2026-11-19"]);
    await until(at(19, 23, 59));
    expect(briefings()).toHaveLength(1);
    // The next day: only what finished since, so "Fix the cart" isn't told twice.
    await until(at(20, 8, 30));
    expect(briefings()).toHaveLength(2);
    expect(briefings()[1]).not.toContain("Fix the cart");
    expect(posted()).toEqual(["2026-11-19", "2026-11-20"]);
  });

  it("no briefing on a day with nothing to say", async () => {
    boot();
    await until(at(19, 12));
    expect(briefings()).toEqual([]);
    expect(posted()).toEqual([]);
  });

  // Review Focus 2: a restart after the briefing went never posts it again that day.
  it("no second briefing after a restart", async () => {
    chat("c1", "Fix the cart");
    finished("c1");
    boot();
    await until(at(19, 8, 31));
    expect(briefings()).toHaveLength(1);
    restart();
    await until(at(19, 9));
    restart();
    await until(at(19, 18));
    expect(briefings()).toHaveLength(1);
    expect(posted()).toEqual(["2026-11-19"]);
  });
});

describe("the briefing's ticks", () => {
  // Task review, 2026-11-20: every tick read the log for today's briefing; once it's posted, ticks read nothing.
  it("ticks don't look for the briefing again once today's is posted", async () => {
    chat("c1", "Fix the cart");
    finished("c1");
    boot();
    await until(at(19, 8, 31));
    expect(briefings()).toHaveLength(1);
    const read = vi.spyOn(store, "read");
    await until(at(19, 18));
    expect(read).not.toHaveBeenCalled();
  });
});

// Final review, 2026-11-20: the first briefing after a long gap (a week away) named everything that finished since
// the last one; it names at most a day back.
describe("the briefing after a gap", () => {
  it("names only what finished in the last day", async () => {
    chat("c1", "Fix the cart");
    finished("c1");
    boot();
    await until(at(19, 8, 31));
    expect(briefings()).toHaveLength(1);
    for (const s of stops) s();
    stops = [];
    vi.setSystemTime(at(22, 12));
    chat("c2", "Old work");
    finished("c2");
    vi.setSystemTime(at(25, 7));
    chat("c3", "New work");
    finished("c3");
    boot();
    await until(at(25, 8, 31));
    expect(briefings()).toHaveLength(2);
    expect(briefings()[1]).toContain("New work");
    expect(briefings()[1]).not.toContain("Old work");
  });
});

// The user, 2026-11-21: "does memory cover todo as well". To-dos are memory files; ion chief's briefing starts with
// what's due today or overdue, then the rest of what's open, in plain words. Done ones aren't named.
describe("the briefing's to-dos", () => {
  it("the briefing lists due and overdue first", async () => {
    const memory = new MemoryFiles({
      root: join(mkdtempSync(join(tmpdir(), "ion-brief-mem-")), "m"),
      store,
      db,
    });
    const todo = (scope: MemoryScope, name: string, more: { due?: string; status?: "done" } = {}) =>
      memory.write({
        scope,
        header: { name, description: name, type: "todo", status: "open", ...more },
        text: name,
        by: "you",
      });
    todo("you", "Update the README", { due: "2026-11-19" });
    todo("you", "Rotate the keys", { due: "2026-11-17" });
    todo("you", "Write the changelog");
    todo("you", "Old thing", { due: "2026-11-19", status: "done" });
    todo({ projectId: "storefront" }, "Fix the cart badge", { due: "2026-11-30" });
    chat("c1", "Fix the cart");
    finished("c1");
    boot(memory);
    await until(at(19, 8, 30));
    expect(briefings()).toHaveLength(1);
    const lines = briefings()[0]!.split("\n");
    expect(lines[0]).toBe("Due today: “Update the README”.");
    expect(lines[1]).toBe("Overdue: “Rotate the keys” (Tue 17 Nov).");
    expect(lines[2]).toBe("Still to do: “Fix the cart badge” (Mon 30 Nov) and “Write the changelog”.");
    expect(lines[3]).toContain("Finished in Storefront");
    expect(briefings()[0]).not.toContain("Old thing");
  });

  it("open to-dos alone are worth a briefing", async () => {
    const memory = new MemoryFiles({
      root: join(mkdtempSync(join(tmpdir(), "ion-brief-mem-")), "m"),
      store,
      db,
    });
    memory.write({
      scope: "you",
      header: { name: "Call the bank", description: "Call the bank", type: "todo", status: "open" },
      text: "Call.",
      by: "you",
    });
    boot(memory);
    await until(at(19, 8, 30));
    expect(briefings()).toEqual(["Still to do: “Call the bank”."]);
  });
});

// The user, 2026-11-22: ion's dream tidies memory overnight ("Apply everything"); the next briefing says what it did
// in a line, and where to undo it.
describe("the briefing after a dream", () => {
  it("the briefing says what dream did", async () => {
    vi.setSystemTime(at(19, 3));
    store.append({
      chatId: null,
      runId: null,
      origin: "daemon",
      type: EV.memoryDreamed,
      data: {
        ...{ merged: 2, updated: 1, forgot: 1, moved: 0, status: "done" },
        forgotten: ["you/old-launch.md"],
        changed: ["you/deploy.md"],
        notes: ["“Sam” may be out of date: Sam moved to Porto in a chat."],
      },
    });
    boot();
    await until(at(19, 8, 30));
    expect(briefings()).toEqual([
      "Tidied memory: merged 2, updated 1, forgot 1 — undo in Memory.\n“Sam” may be out of date: Sam moved to Porto in a chat.",
    ]);
    // Said once: the next day's briefing has nothing new to say.
    await until(at(20, 8, 30));
    expect(briefings()).toHaveLength(1);
  });
});
