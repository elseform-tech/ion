import type { NewEvent } from "@ion/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { runsView } from "../views/runs.js";
import { type Db, EventStore, openDb } from "./index.js";

const ev = (
  runId: string,
  type: NewEvent["type"] = "message.delta",
  data: Record<string, unknown> = {},
): NewEvent => ({
  chatId: "c1",
  runId,
  origin: "adapter",
  type,
  data,
});

describe("EventStore", () => {
  let db: Db;
  let store: EventStore;
  beforeEach(() => {
    db = openDb(":memory:");
    store = new EventStore(db, [runsView]);
  });

  it("assigns gapless seq per run, independently for two runs", () => {
    store.append(ev("r1"));
    store.append(ev("r2"));
    store.append(ev("r1"));
    store.append(ev("r2"));
    store.append(ev("r1"));
    expect(store.read({ runId: "r1" }).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(store.read({ runId: "r2" }).map((e) => e.seq)).toEqual([1, 2]);
  });

  it("numbers chat-level events per chat when there is no run", () => {
    const a = store.append({
      chatId: "c9",
      runId: null,
      origin: "daemon",
      type: "chat.created",
      data: { title: "x", projectId: null },
    });
    expect(a.seq).toBe(1);
  });

  it("is idempotent on id", () => {
    const a = store.append({ ...ev("r1"), id: "01JD00000000000000000000AA" });
    const b = store.append({ ...ev("r1"), id: "01JD00000000000000000000AA" });
    expect(b).toEqual(a);
    expect(store.read({ runId: "r1" })).toHaveLength(1);
  });

  it("validates before writing", () => {
    expect(() => store.append(ev("r1", "run.finished", { status: "great" }))).toThrow();
    expect(() => store.append({ ...ev("r1"), type: "nope" as never })).toThrow();
    expect(store.read({ runId: "r1" })).toHaveLength(0);
  });

  it("reads after a given id", () => {
    const a = store.append(ev("r1"));
    const b = store.append(ev("r1"));
    expect(store.read({ chatId: "c1", afterId: a.id }).map((e) => e.id)).toEqual([b.id]);
  });

  it("updates the runs view in the same transaction", () => {
    store.append(ev("r1", "run.started", { harness: "fake", model: "m", effort: null }));
    store.append(ev("r1", "run.finished", { status: "failed" }));
    expect(runsView.rows(db)).toMatchObject([{ runId: "r1", status: "failed", harness: "fake" }]);
  });

  it("rebuilding views from the log gives the same rows", () => {
    store.append(ev("r1", "run.started", { harness: "fake", model: "m", effort: "high" }));
    store.append(ev("r2", "run.started", { harness: "fake", model: "m", effort: null }));
    store.append(ev("r1", "run.finished", { status: "done" }));
    const before = runsView.rows(db);
    store.rebuildViews();
    expect(runsView.rows(db)).toEqual(before);
  });

  it("notifies subscribers after commit, and stops after unsubscribe", () => {
    const seen: string[] = [];
    const off = store.onAppend((e) => seen.push(e.id));
    const a = store.append(ev("r1"));
    off();
    store.append(ev("r1"));
    expect(seen).toEqual([a.id]);
  });
});
