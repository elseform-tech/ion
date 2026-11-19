import type { NewEvent } from "@ion/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "./index.js";
import { runsView } from "./runs.js";

let db: Db;
let store: EventStore;
const d = (e: Omit<NewEvent, "origin">): NewEvent => ({ origin: "daemon", ...e });

beforeEach(() => {
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
});

// Settings → an ion's page: its threads' runs, how many succeeded, what they cost, and runs per day.
describe("runsView.stats", () => {
  it("counts the runs of some chats over 30 days, with their cost", () => {
    const run = (chatId: string, runId: string, status: string, cost: number | null) => {
      store.append(
        d({
          chatId,
          runId,
          type: "run.started",
          data: { harness: "fake", model: "m", effort: null, authMethod: null },
        }),
      );
      store.append(
        d({
          chatId,
          runId,
          type: "usage.reported",
          data: { model: "m", inputTokens: 1, outputTokens: 1, costUsd: cost },
        }),
      );
      store.append(d({ chatId, runId, type: "run.finished", data: { status } }));
    };
    run("a", "r1", "done", 0.25);
    run("a", "r2", "failed", 0.5);
    run("b", "r3", "done", null);
    run("other", "r4", "done", 9);
    const s = runsView.stats(db, ["a", "b"], new Date());
    expect(s).toMatchObject({ runs: 3, succeeded: 2, costUsd: 0.75 });
    expect(s.perDay).toHaveLength(30);
    expect(s.perDay.at(-1)).toBe(3);
  });
});
