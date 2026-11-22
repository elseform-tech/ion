import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import { EV, type MemoryScope } from "@ion/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryFiles } from "../memory/index.js";
import { Notifier } from "../notify/index.js";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";

// The user, 2026-11-21: "does memory cover todo as well". A to-do with a date gets one reminder that morning, in ion
// chief's thread (at the briefing's time, or 9:00 without one), recorded so it never comes twice; a done or forgotten
// to-do never reminds.

let db: Db;
let store: EventStore;
let memory: MemoryFiles;
let configFile: string;
let stops: (() => void)[] = [];

const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m);
const until = (t: Date) => vi.advanceTimersByTimeAsync(t.getTime() - Date.now());

function save(briefing: boolean, projects = [{ id: "storefront", path: "/p/s", starred: false }]) {
  saveUserConfig(configFile, {
    ...DEFAULT_CONFIG,
    notifications: {
      briefing: { on: briefing, at: "08:30" },
      quiet: { on: false, from: "22:00", to: "08:00" },
    },
    projects,
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
  save(false);
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
    restart();
    await until(at(20, 18));
    restart();
    await until(at(21, 10));
    expect(said()).toEqual(["Due today: “Update the README”."]);
    expect(store.read({ types: [EV.todoReminded] }).map((e) => e.data)).toEqual([
      { path: "you/update-the-readme.md", due: "2026-11-20" },
    ]);
  });

  it("with a briefing, the briefing is the reminder: it's said once", async () => {
    save(true);
    todo("you", "Update the README", "2026-11-19");
    boot();
    await until(at(19, 12));
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
    save(false, [{ id: "private", path: "/p/p", starred: false, shareWithIon: false } as never]);
    todo({ projectId: "private" }, "Rotate the keys", "2026-11-19");
    boot();
    await until(at(19, 12));
    expect(said()).toEqual([]);
  });
});
