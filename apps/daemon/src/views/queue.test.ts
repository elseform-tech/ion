import { EV } from "@ion/schema";
import { describe, expect, it } from "vitest";
import { EventStore, openDb } from "../store/index.js";
import { allViews } from "./index.js";
import { queueView } from "./queue.js";

describe("the queue view", () => {
  // Task review, 2026-11-19: the view gained its `why` column without a new version, so a database made before
  // kept the old table and a failed send couldn't be recorded. Its version changed: the table rebuilds from the log.
  it("rebuilds a table from before `why`, from the log", () => {
    const db = openDb(":memory:");
    db.exec(`CREATE TABLE view_queue (queue_id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL,
      text TEXT NOT NULL, brain TEXT NOT NULL, state TEXT NOT NULL, added_at TEXT NOT NULL)`);
    db.exec("CREATE TABLE view_versions (name TEXT PRIMARY KEY, version INTEGER NOT NULL)");
    db.exec("INSERT INTO view_versions (name, version) VALUES ('queue', 1)");
    const store = new EventStore(db, allViews);
    const queueId = "queue_1";
    const add = { queueId, to: { ionId: "chief" }, text: "hi", brain: {} };
    store.append({ chatId: "ion:chief", runId: null, origin: "daemon", type: EV.queueAdded, data: add });
    store.append({
      chatId: "ion:chief",
      runId: null,
      origin: "daemon",
      type: EV.queueFailed,
      data: { queueId, why: "No" },
    });
    expect(queueView.waiting(db, { ionId: "chief" })).toMatchObject([{ queueId, why: "No" }]);
  });
});
