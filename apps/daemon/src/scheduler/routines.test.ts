import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadUserConfig, type RoutineEntry, saveUserConfig } from "@ion/config";
import { EV } from "@ion/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { Routines } from "./routines.js";

let db: Db;
let store: EventStore;
let configFile: string;
let start: ReturnType<typeof vi.fn>;
let stops: (() => void)[] = [];

const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m);
const HOUR = 3_600_000;

const save = (routines: RoutineEntry[], paused = false) =>
  saveUserConfig(configFile, {
    ...DEFAULT_CONFIG,
    ...(paused ? { routines: { paused } } : {}),
    projects: [{ id: "storefront", path: "/p/storefront", starred: false, routines }],
  });

const morning: RoutineEntry = {
  id: "morning",
  name: "Morning check",
  when: "daily 09:00",
  text: "Run the tests.",
  on: true,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at(19, 8));
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
  configFile = join(mkdtempSync(join(tmpdir(), "ion-routines-")), "config.toml");
  save([morning]);
  let n = 0;
  start = vi.fn(async () => ({ chatId: `t${++n}` }));
});

afterEach(() => {
  for (const s of stops) s();
  stops = [];
  vi.useRealTimers();
});

/** A daemon's scheduler, ticking (a restart is a new one over the same store). */
function boot(): Routines {
  const r = new Routines({ store, db, configFile, start });
  stops.push(r.start());
  return r;
}

const ran = () =>
  store
    .read({})
    .filter((e) => e.type === EV.routineRan)
    .map((e) => e.data as Record<string, unknown>);

describe("routines run on their schedule", { timeout: 20_000 }, () => {
  it("runs when due, as its ion's thread, and records it", async () => {
    boot();
    await vi.advanceTimersByTimeAsync(HOUR - 60_000);
    expect(start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(
      "storefront",
      expect.objectContaining({ name: "Morning check" }),
      "schedule",
    );
    expect(ran()).toEqual([
      {
        projectId: "storefront",
        routineId: "morning",
        name: "Morning check",
        due: at(19, 9).toISOString(),
        by: "schedule",
        chatId: "t1",
      },
    ]);
  });

  it("runs at most once per due time, across restarts too", async () => {
    boot();
    await vi.advanceTimersByTimeAsync(3 * HOUR);
    expect(start).toHaveBeenCalledTimes(1);
    for (const s of stops) s();
    boot();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(start).toHaveBeenCalledTimes(1);
    // The next day's slot runs.
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("a run missed while ion was stopped runs once at start, not once per missed slot", async () => {
    boot();
    await vi.advanceTimersByTimeAsync(2 * HOUR); // runs the 19th's
    for (const s of stops) s();
    vi.setSystemTime(at(22, 12)); // stopped through the 20th, 21st and 22nd
    boot();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(start).toHaveBeenCalledTimes(2);
    expect(ran()[1]?.due).toBe(at(22, 9).toISOString());
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("doesn't run while it's off, nor catch up when it's turned on", async () => {
    save([{ ...morning, on: false }]);
    const r = boot();
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(start).not.toHaveBeenCalled();
    save([morning]);
    r.hold("storefront", "morning");
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("doesn't run while pause all is on", async () => {
    save([morning], true);
    boot();
    await vi.advanceTimersByTimeAsync(3 * HOUR);
    expect(start).not.toHaveBeenCalled();
    expect(ran()).toEqual([]);
  });

  it("skips the one run you skipped, then runs again", async () => {
    save([{ ...morning, skip: at(19, 9).toISOString() }]);
    boot();
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(start).not.toHaveBeenCalled();
    expect(ran()).toEqual([expect.objectContaining({ due: at(19, 9).toISOString(), skipped: true })]);
    // The skip is spent: it's gone from your config.
    expect(loadUserConfig(configFile).config.projects[0]?.routines?.[0]?.skip).toBeUndefined();
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("says why when its thread can't start, and doesn't try that slot again", async () => {
    start.mockResolvedValueOnce({ why: "No agent is ready" });
    boot();
    await vi.advanceTimersByTimeAsync(3 * HOUR);
    expect(start).toHaveBeenCalledTimes(1);
    expect(ran()).toEqual([expect.objectContaining({ why: "No agent is ready", by: "schedule" })]);
  });

  it("a new routine waits for its first time, even if one passed today", async () => {
    vi.setSystemTime(at(19, 10));
    boot();
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(start).not.toHaveBeenCalled();
  });
});

describe("run now", () => {
  it("starts it whatever its schedule, and keeps the schedule", async () => {
    const r = boot();
    expect(await r.run("storefront", "morning")).toEqual({ chatId: "t1" });
    expect(start).toHaveBeenCalledWith("storefront", expect.objectContaining({ id: "morning" }), "you");
    expect(ran()).toEqual([expect.objectContaining({ by: "you", due: null, chatId: "t1" })]);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("refuses an unknown routine, and says why it couldn't start", async () => {
    const r = boot();
    await expect(r.run("storefront", "nope")).rejects.toThrow("Unknown routine: nope");
    start.mockResolvedValueOnce({ why: "No agent is ready" });
    await expect(r.run("storefront", "morning")).rejects.toThrow("No agent is ready");
  });
});

describe("next", () => {
  it("is its next time, after a skipped one, and null while it's paused", () => {
    const r = boot();
    expect(r.next(morning)).toEqual(at(19, 9));
    expect(r.next({ ...morning, skip: at(19, 9).toISOString() })).toEqual(at(20, 9));
    expect(r.next({ ...morning, on: false })).toBeNull();
    save([morning], true);
    expect(r.next(morning)).toBeNull();
  });
});
