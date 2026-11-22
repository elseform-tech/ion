import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import { EV, type MemoryScope } from "@ion/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryFiles } from "../memory/index.js";
import { ScopedMemory } from "../memory/scoped.js";
import { Notifier } from "../notify/index.js";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";

// The user, 2026-11-21: "does memory cover todo as well". A to-do with a date gets one reminder that morning, in ion
// chief's thread, recorded so it never comes twice; a done or forgotten to-do never reminds. Task review, 2026-11-22
// (ruling): the reminder is a real notification ("needs you", by the project's level), at 9:00 local or when quiet
// hours end, never at a late briefing's time.

let db: Db;
let store: EventStore;
let memory: MemoryFiles;
let configFile: string;
let stops: (() => void)[] = [];

const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m);
const until = (t: Date) => vi.advanceTimersByTimeAsync(t.getTime() - Date.now());

type Opts = { briefing?: string; quiet?: [string, string]; projects?: unknown[] };
function save(o: Opts = {}) {
  saveUserConfig(configFile, {
    ...DEFAULT_CONFIG,
    notifications: {
      briefing: { on: o.briefing !== undefined, at: o.briefing ?? "08:30" },
      quiet: { on: !!o.quiet, from: o.quiet?.[0] ?? "22:00", to: o.quiet?.[1] ?? "08:00" },
    },
    projects: (o.projects ?? [{ id: "storefront", path: "/p/s", starred: false }]) as never,
  });
}

const todo = (scope: MemoryScope, name: string, due: string, status: "open" | "done" = "open") =>
  memory.write({
    scope,
    header: { name, description: name, type: "todo", status, due },
    text: name,
    by: "you",
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at(19, 7));
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
  const root = mkdtempSync(join(tmpdir(), "ion-remind-"));
  configFile = join(root, "config.toml");
  memory = new MemoryFiles({ root: join(root, "memory"), store, db });
  save();
});

afterEach(() => {
  for (const s of stops) s();
  stops = [];
  vi.useRealTimers();
});

function boot(): void {
  const x = new Notifier({ store, db, configFile, memory });
  x.start();
  stops.push(() => x.stop());
}

function restart(): void {
  for (const s of stops) s();
  stops = [];
  boot();
}

const notified = () =>
  store
    .read({ chatId: "notify" })
    .filter((e) => e.type === EV.notify)
    .map((e) => e.data);

const README = { title: "ion", body: "Due today: “Update the README”.", chatId: "ion:chief", kind: "needs" };

const said = () =>
  store
    .read({ chatId: "ion:chief" })
    .filter((e) => e.type === EV.ionSaid)
    .map((e) => (e.data as { text: string }).text);

describe("to-do reminders", () => {
  it("a due to-do is reminded once that morning", async () => {
    todo("you", "Update the README", "2026-11-20");
    todo("you", "Ship it", "2026-11-20", "done");
    todo("you", "Gone soon", "2026-11-20");
    memory.forget("you/gone-soon.md", "you");
    boot();
    await until(at(19, 23));
    expect(said()).toEqual([]);
    await until(at(20, 8, 59));
    expect(said()).toEqual([]);
    await until(at(20, 9, 1));
    expect(said()).toEqual(["Due today: “Update the README”."]);
    expect(notified()).toEqual([README]);
    restart();
    await until(at(20, 18));
    restart();
    await until(at(21, 10));
    expect(said()).toEqual(["Due today: “Update the README”."]);
    expect(store.read({ types: [EV.todoReminded] }).map((e) => e.data)).toEqual([
      { path: "you/update-the-readme.md", due: "2026-11-20" },
    ]);
  });

  it("the reminder notifies you once, at 9:00, whatever the briefing's time", async () => {
    save({ briefing: "11:00" });
    todo("you", "Update the README", "2026-11-19");
    boot();
    await until(at(19, 8, 59));
    expect(notified()).toEqual([]);
    await until(at(19, 9, 1));
    expect(said()).toEqual(["Due today: “Update the README”."]);
    expect(notified()).toEqual([README]);
    await until(at(19, 12));
    expect(notified()).toEqual([README]);
  });

  it("quiet hours hold it until they end", async () => {
    save({ quiet: ["22:00", "10:00"] });
    todo("you", "Update the README", "2026-11-19");
    boot();
    await until(at(19, 9, 30));
    expect(notified()).toEqual([]);
    await until(at(19, 10, 1));
    expect(notified()).toEqual([README]);
  });

  it("a project's level decides whether it notifies; the line is said either way", async () => {
    save({
      projects: [{ id: "storefront", name: "Storefront", path: "/p/s", starred: false, notify: "digest" }],
    });
    todo({ projectId: "storefront" }, "Rotate the keys", "2026-11-19");
    boot();
    await until(at(19, 9, 1));
    expect(said()).toEqual(["Due today: “Rotate the keys”."]);
    expect(notified()).toEqual([]);
  });

  // Task review, 2026-11-22: an edit after 9:00 (ion stopped then) kept a to-do made days before from its reminder.
  it("goes by when the to-do was made, not when it last changed", async () => {
    vi.setSystemTime(at(18, 12));
    todo("you", "Update the README", "2026-11-19");
    vi.setSystemTime(at(19, 9, 30));
    const f = new ScopedMemory(memory, { kind: "you" }).read("update-the-readme");
    new ScopedMemory(memory, { kind: "you" }).write({
      scope: "you",
      path: f.path,
      text: "More",
      expect: f.hash,
    });
    boot();
    await until(at(19, 10));
    expect(said()).toEqual(["Due today: “Update the README”."]);
  });

  it("a to-do written after the reminder's time isn't reminded that day", async () => {
    boot();
    await until(at(19, 10));
    todo("you", "Call the bank", "2026-11-19");
    await until(at(19, 18));
    expect(said()).toEqual([]);
  });

  it("a project kept from ion chief isn't reminded in its thread", async () => {
    save({ projects: [{ id: "private", path: "/p/p", starred: false, shareWithIon: false }] });
    todo({ projectId: "private" }, "Rotate the keys", "2026-11-19");
    boot();
    await until(at(19, 12));
    expect(said()).toEqual([]);
  });

  // Final review, 2026-11-22: a to-do in a project not shared with ion chief never got its reminder at all; only
  // the line in ion chief's thread is for shared projects, the notification is yours either way.
  it("a project kept from ion chief still notifies you, once", async () => {
    save({
      projects: [{ id: "private", name: "Private", path: "/p/p", starred: false, shareWithIon: false }],
    });
    todo({ projectId: "private" }, "Rotate the keys", "2026-11-19");
    boot();
    await until(at(19, 9, 1));
    expect(said()).toEqual([]);
    expect(notified()).toEqual([{ title: "Private", body: "Due today: “Rotate the keys”.", kind: "needs" }]);
    restart();
    await until(at(19, 12));
    expect(notified()).toHaveLength(1);
  });
});
