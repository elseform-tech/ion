import type { NewEvent } from "@ion/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { runsView } from "../views/runs.js";
import { type Db, EventStore, openDb } from "./index.js";

const ev = (
  runId: string,
  type: NewEvent["type"] = "message.delta",
  data: Record<string, unknown> = { text: "x" },
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

  it("refuses a repeated id whose content differs", () => {
    store.append({ ...ev("r1"), id: "01JD00000000000000000000AB" });
    expect(() => store.append({ ...ev("r2"), id: "01JD00000000000000000000AB" })).toThrow(/different event/);
  });

  it("refuses daemon-only events claimed by an adapter", () => {
    expect(() => store.append({ ...ev("r1", "need.raised"), origin: "adapter" })).toThrow(/daemon-only/);
  });

  it("keeps run and chat sequences apart even when ids match", () => {
    store.append({
      chatId: "x",
      runId: null,
      origin: "daemon",
      type: "chat.created",
      data: { title: "t", projectId: null },
    });
    expect(
      store.append({
        chatId: "c1",
        runId: "x",
        origin: "adapter",
        type: "message.delta",
        data: { text: "x" },
      }).seq,
    ).toBe(1);
  });

  it("refuses empty chat and run ids", () => {
    expect(() => store.append({ ...ev(""), runId: "" })).toThrow();
  });

  it("throws on an unknown afterId instead of returning everything", () => {
    store.append(ev("r1"));
    expect(() => store.read({ chatId: "c1", afterId: "01JDNOPE" })).toThrow("Unknown event id: 01JDNOPE");
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
    store.append(ev("r1", "run.started", { harness: "fake", model: "m", effort: null, authMethod: null }));
    store.append(ev("r1", "run.finished", { status: "failed" }));
    expect(runsView.rows(db)).toMatchObject([{ runId: "r1", status: "failed", harness: "fake" }]);
  });

  it("rebuilding views from the log gives the same rows", () => {
    store.append(ev("r1", "run.started", { harness: "fake", model: "m", effort: "high", authMethod: null }));
    store.append(ev("r2", "run.started", { harness: "fake", model: "m", effort: null, authMethod: null }));
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

// An existing database from an older ion has view tables with older columns.
describe("view versions", () => {
  const view = (version: number, columns: string) => ({
    name: "demo",
    version,
    tables: ["view_demo"],
    migrate: (db: Db) => db.exec(`CREATE TABLE IF NOT EXISTS view_demo (${columns})`),
    reset: (db: Db) => db.exec("DELETE FROM view_demo"),
    apply: (db: Db, e: { chatId: string | null }) => {
      if (version === 2) db.prepare("INSERT INTO view_demo (chat_id, extra) VALUES (?, 'x')").run(e.chatId);
      else db.prepare("INSERT INTO view_demo (chat_id) VALUES (?)").run(e.chatId);
    },
  });

  it("rebuilds a view whose version changed, from the log", () => {
    const db = openDb(":memory:");
    const old = new EventStore(db, [view(1, "chat_id TEXT")]);
    old.append({ chatId: "c1", runId: null, origin: "daemon", type: "chat.archived", data: {} } as NewEvent);
    expect(new EventStore(db, [view(2, "chat_id TEXT, extra TEXT")])).toBeInstanceOf(EventStore);
    expect(db.prepare("SELECT chat_id, extra FROM view_demo").all()).toEqual([{ chat_id: "c1", extra: "x" }]);
  });

  it("leaves a view alone when its version is the same", () => {
    const db = openDb(":memory:");
    new EventStore(db, [view(1, "chat_id TEXT")]).append({
      chatId: "c1",
      runId: null,
      origin: "daemon",
      type: "chat.archived",
      data: {},
    } as NewEvent);
    db.exec("INSERT INTO view_demo (chat_id) VALUES ('kept')");
    expect(new EventStore(db, [view(1, "chat_id TEXT")])).toBeInstanceOf(EventStore);
    expect(db.prepare("SELECT count(*) AS n FROM view_demo").get()).toEqual({ n: 2 });
  });
});
