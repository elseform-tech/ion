import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import { EV } from "@ion/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { Notifier } from "./index.js";

// The user, 2026-11-19: "also build the settings as well … notifications …"; the lab: "Roles tell ion; ion decides
// how loud". Urgent things notify; needs and updates notify by the project's level (else they're pinned or wait for
// the briefing); quiet hours hold every notification until they end, then one summary.

type Level = "all" | "needs" | "digest" | "muted";

let db: Db;
let store: EventStore;
let configFile: string;
let stops: (() => void)[] = [];
let n = 0;

const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m);

function save(o: { level?: Level; quiet?: { on: boolean; from: string; to: string } } = {}) {
  saveUserConfig(configFile, {
    ...DEFAULT_CONFIG,
    notifications: {
      briefing: { on: false, at: "08:30" },
      quiet: o.quiet ?? { on: true, from: "22:00", to: "08:00" },
    },
    projects: [
      {
        id: "storefront",
        name: "Storefront",
        path: "/p/storefront",
        starred: false,
        ...(o.level ? { notify: o.level } : {}),
      },
    ],
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at(19, 12));
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
  configFile = join(mkdtempSync(join(tmpdir(), "ion-notify-")), "config.toml");
  save();
  store.append({
    chatId: "c1",
    runId: null,
    origin: "daemon",
    type: EV.chatCreated,
    data: { title: "Fix the cart", projectId: "storefront" },
  });
});

afterEach(() => {
  for (const s of stops) s();
  stops = [];
  vi.useRealTimers();
});

/** A daemon's notifier (a restart is a new one over the same store). */
function boot(): Notifier {
  const x = new Notifier({ store, db, configFile });
  x.start();
  stops.push(() => x.stop());
  return x;
}

function need(summary: string, blocked = false): string {
  const needId = `n${++n}`;
  store.append({
    chatId: "c1",
    runId: "r1",
    origin: "daemon",
    type: EV.needRaised,
    data: {
      ...{ needId, requestId: `ask_${needId}`, kind: "ask", summary, detail: null },
      dedupeKey: `ask:${needId}`,
      ...(blocked ? { blocked: true } : {}),
    },
  });
  return needId;
}

function finished(status: string): void {
  store.append({ chatId: "c1", runId: `r${++n}`, origin: "daemon", type: EV.runFinished, data: { status } });
}

const notified = () =>
  store
    .read({ chatId: "notify" })
    .filter((e) => e.type === EV.notify)
    .map((e) => e.data as { title: string; body: string; chatId?: string; kind: string });

/** Moves the clock to `t`, firing the timers due on the way. */
const until = (t: Date) => vi.advanceTimersByTimeAsync(t.getTime() - Date.now());

describe("the notifier", () => {
  it("an urgent need notifies at once", () => {
    boot();
    need("Allow npm install?", true);
    expect(notified()).toEqual([
      { title: "Storefront", body: "Allow npm install?", chatId: "c1", kind: "urgent" },
    ]);
  });

  it.each([
    ["all", ["urgent", "needs", "update"]],
    ["needs", ["urgent", "needs"]],
    ["digest", ["urgent"]],
    ["muted", []],
  ] as const)("a project's level decides what notifies (%s)", (level, kinds) => {
    save({ level });
    boot();
    need("Allow npm install?", true);
    need("Which database?");
    finished("done");
    expect(notified().map((x) => x.kind)).toEqual(kinds);
    if (level === "all") expect(notified()[2]?.body).toBe("Finished: Fix the cart");
  });

  // Task review, 2026-11-20: a run ion's own stop or restart ended didn't give up; it's not a failure to tell.
  it.each(["daemon_restarted", "daemon_stopped"])("a run ion's own %s ended isn't urgent", (code) => {
    boot();
    const runId = `r${++n}`;
    const data = { code, retryable: false, message: "ion stopped" };
    store.append({ chatId: "c1", runId, origin: "daemon", type: EV.error, data });
    store.append({ chatId: "c1", runId, origin: "daemon", type: EV.runFinished, data: { status: "failed" } });
    expect(notified()).toEqual([]);
  });

  it("a run that gave up is urgent; one you stopped isn't news", () => {
    boot();
    finished("interrupted");
    finished("failed");
    expect(notified()).toEqual([
      { title: "Storefront", body: "Failed: Fix the cart", chatId: "c1", kind: "urgent" },
    ]);
  });
});

describe("quiet hours", () => {
  // Review Focus 1, 5: across midnight, 07:59 is held and 08:00 goes; ten at once make one summary, sent once.
  it("quiet hours across midnight hold, then one summary at the end", async () => {
    vi.setSystemTime(at(19, 23));
    boot();
    for (let i = 0; i < 10; i++) need(`Allow call ${i}?`, true);
    await until(at(20, 7, 59));
    need("Which database?");
    expect(notified()).toEqual([]);
    await until(at(20, 8));
    expect(notified()).toEqual([{ title: "ion", body: "11 things need you", kind: "summary" }]);
    need("Allow npm install?", true);
    await until(at(20, 21));
    expect(notified().map((x) => x.kind)).toEqual(["summary", "urgent"]);
  });

  it("same-day quiet hours hold too, and one held thing reads as one", async () => {
    save({ quiet: { on: true, from: "13:00", to: "14:00" } });
    vi.setSystemTime(at(19, 12, 59));
    boot();
    need("Before", true);
    await until(at(19, 13));
    need("During", true);
    await until(at(19, 14));
    expect(notified().map((x) => x.body)).toEqual(["Before", "1 thing needs you"]);
  });

  // Review Focus 2: what's held is in the events, so a restart during quiet hours still sends the summary, once.
  it("held notifications survive a restart", async () => {
    vi.setSystemTime(at(19, 23));
    boot();
    need("Allow call?", true);
    need("Which database?");
    for (const s of stops) s();
    stops = [];
    await until(at(20, 1));
    boot();
    need("Allow push?", true);
    await until(at(20, 8));
    expect(notified()).toEqual([{ title: "ion", body: "3 things need you", kind: "summary" }]);
    for (const s of stops) s();
    stops = [];
    boot();
    await until(at(20, 9));
    expect(notified()).toHaveLength(1);
  });
});

// Task review, 2026-11-20: the summary counted what it never held (a night with quiet hours off, the first start
// after an upgrade, needs you already answered) and could go out during the next quiet hours.
describe("the summary counts only what it held", () => {
  it("turn quiet on at 15:00 after a night with needs: no summary", async () => {
    save({ quiet: { on: false, from: "22:00", to: "08:00" } });
    vi.setSystemTime(at(19, 23));
    boot();
    need("Allow call?", true);
    need("Which database?");
    await until(at(20, 15));
    save();
    await until(at(20, 15, 30));
    expect(notified().map((x) => x.kind)).toEqual(["urgent", "needs"]);
  });

  it("first start after upgrade: no summary", async () => {
    vi.setSystemTime(at(19, 23));
    need("Allow call?", true);
    vi.setSystemTime(at(20, 12));
    boot();
    await until(at(20, 13));
    expect(notified()).toEqual([]);
  });

  it("answered needs aren't counted", async () => {
    save({ level: "all" });
    vi.setSystemTime(at(19, 23));
    boot();
    const answered = need("Allow call?", true);
    need("Which database?");
    finished("done");
    const data = { needId: answered, decision: "answered", by: "you", choice: "Allow" };
    store.append({ chatId: "c1", runId: "r1", origin: "daemon", type: EV.needResolved, data });
    await until(at(20, 8));
    expect(notified()).toEqual([{ title: "ion", body: "1 thing needs you", kind: "summary" }]);
  });

  it("no summary during the next quiet window", async () => {
    vi.setSystemTime(at(19, 23));
    boot();
    need("Allow call?", true);
    for (const s of stops) s();
    stops = [];
    vi.setSystemTime(at(20, 23));
    boot();
    await until(at(20, 23, 30));
    expect(notified()).toEqual([]);
  });

  // Task review, 2026-11-20: every tick read the whole log; once the window is summed up, ticks read nothing.
  it("ticks don't read the events again once the last window is settled", async () => {
    boot();
    const read = vi.spyOn(store, "read");
    await until(at(19, 18));
    expect(read).not.toHaveBeenCalled();
  });
});
