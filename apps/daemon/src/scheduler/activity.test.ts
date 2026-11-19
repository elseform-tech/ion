import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadUserConfig, saveUserConfig } from "@ion/config";
import { EV, type EventType } from "@ion/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { activityOf } from "./activity.js";
import { Routines } from "./routines.js";

let db: Db;
let store: EventStore;
let configFile: string;

const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at(19, 8));
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
  configFile = join(mkdtempSync(join(tmpdir(), "ion-activity-")), "config.toml");
  saveUserConfig(configFile, {
    ...DEFAULT_CONFIG,
    projects: [
      {
        id: "storefront",
        path: "/p/s",
        starred: false,
        name: "Storefront",
        effort: "high",
        routines: [
          { id: "deps", name: "Deps", when: "mon 09:00", text: "Update deps.", on: true },
          { id: "old", name: "Old", when: "daily 07:00", text: "x", on: false },
        ],
      },
      {
        id: "docs",
        path: "/p/d",
        starred: false,
        routines: [{ id: "check", name: "Check", when: "daily 09:00", text: "y", on: true, effort: "low" }],
      },
    ],
  });
});

afterEach(() => vi.useRealTimers());

const ev = ([chatId, runId]: [string | null, string | null], type: EventType, data: object, ts?: Date) =>
  store.append({ chatId, runId, origin: "daemon", type, data, ...(ts ? { ts: ts.toISOString() } : {}) });

/** A thread (by ion, or yours) with one run that started at `t` and ended `status`, costing `cost`. */
function thread(chatId: string, t: Date, o: { by?: "ion"; status?: string; cost?: number } = {}) {
  ev(
    [chatId, null],
    EV.chatCreated,
    { title: `T ${chatId}`, projectId: "storefront", ...(o.by ? { by: o.by } : {}) },
    t,
  );
  const runId = `r-${chatId}`;
  ev([chatId, runId], EV.runStarted, { harness: "fake", model: "m", effort: null, authMethod: null }, t);
  if (o.cost !== undefined)
    ev(
      [chatId, runId],
      EV.usageReported,
      { model: "m", inputTokens: 1, outputTokens: 1, costUsd: o.cost },
      t,
    );
  if (o.status) ev([chatId, runId], EV.runFinished, { status: o.status }, t);
}

const activity = () => {
  const routines = new Routines({ store, db, configFile, start: vi.fn() });
  return activityOf({ db, configFile, routines }, new Date());
};

describe("activity", () => {
  it("lists what's next, soonest first, with its ion and effort; paused ones last", () => {
    const a = activity();
    expect(a.paused).toBe(false);
    expect(a.upcoming).toEqual([
      {
        projectId: "docs",
        routineId: "check",
        name: "Check",
        when: "daily 09:00",
        ion: "docs",
        next: at(19, 9).toISOString(),
        effort: "low",
        on: true,
        skipped: false,
      },
      expect.objectContaining({
        routineId: "deps",
        ion: "Storefront",
        next: at(23, 9).toISOString(),
        effort: "high",
      }),
      expect.objectContaining({ routineId: "old", next: null, on: false }),
    ]);
  });

  it("lists ion threads' runs today and yesterday, newest first, with the routine that started each", () => {
    vi.setSystemTime(at(19, 15));
    thread("a", at(19, 9), { by: "ion", status: "done", cost: 0.21 });
    ev([null, null], EV.routineRan, {
      projectId: "storefront",
      routineId: "deps",
      name: "Deps",
      due: at(19, 9).toISOString(),
      by: "schedule",
      chatId: "a",
    });
    thread("b", at(19, 11), { by: "ion" });
    thread("c", at(18, 17), { by: "ion", status: "failed" });
    thread("d", at(16, 10), { by: "ion", status: "done" }); // older: not shown
    thread("e", at(19, 12), { status: "done" }); // your own chat: not shown
    const a = activity();
    expect(a.today).toEqual([
      expect.objectContaining({ chatId: "b", title: "T b", status: "running", costUsd: null, routine: null }),
      {
        runId: "r-a",
        chatId: "a",
        title: "T a",
        projectId: "storefront",
        ion: "Storefront",
        routine: "Deps",
        status: "done",
        costUsd: 0.21,
        at: at(19, 9).toISOString(),
      },
    ]);
    expect(a.yesterday.map((r) => [r.chatId, r.status])).toEqual([["c", "failed"]]);
  });

  it("marks a routine whose next run you skipped; next is the one after", () => {
    vi.setSystemTime(at(19, 8));
    const cfg = loadUserConfig(configFile).config;
    const docs = cfg.projects[1]!;
    docs.routines = [{ ...docs.routines![0]!, skip: at(19, 9).toISOString() }];
    saveUserConfig(configFile, cfg);
    const check = activity().upcoming.find((u) => u.routineId === "check");
    expect(check).toMatchObject({ skipped: true, next: at(20, 9).toISOString() });
    // Once that time has passed, a leftover skip means nothing.
    vi.setSystemTime(at(19, 10));
    expect(activity().upcoming.find((u) => u.routineId === "check")?.skipped).toBe(false);
  });

  it("says when everything is paused", () => {
    saveUserConfig(configFile, { ...DEFAULT_CONFIG, routines: { paused: true } });
    expect(activity()).toEqual({ paused: true, upcoming: [], today: [], yesterday: [] });
  });
});
