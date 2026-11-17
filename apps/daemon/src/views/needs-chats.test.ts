import type { NewEvent } from "@ion/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { type Db, EventStore, openDb } from "../store/index.js";
import { chatsView } from "./chats.js";
import { allViews } from "./index.js";
import { needsView } from "./needs.js";

let db: Db;
let store: EventStore;
const d = (e: Omit<NewEvent, "origin">): NewEvent => ({ origin: "daemon", ...e });

beforeEach(() => {
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
  store.append(
    d({
      chatId: "c1",
      runId: null,
      type: "chat.created",
      data: { title: "Fix it", projectId: "app", worktree: "/w/c1", branch: "ion/fix-it-abc123" },
    }),
  );
  store.append({
    chatId: "c1",
    runId: "r1",
    origin: "adapter",
    type: "run.started",
    data: { harness: "fake", model: "m", effort: null, authMethod: null },
  });
  store.append(
    d({
      chatId: "c1",
      runId: "r1",
      type: "need.raised",
      data: {
        needId: "n1",
        requestId: "q1",
        kind: "command",
        summary: "Run pnpm test",
        detail: null,
        dedupeKey: "k1",
      },
    }),
  );
  store.append(
    d({
      chatId: "c1",
      runId: "r1",
      type: "need.raised",
      data: {
        needId: "n2",
        requestId: "q2",
        kind: "edit",
        summary: "Edit /etc/hosts",
        detail: null,
        dedupeKey: "k2",
      },
    }),
  );
});

describe("needs view", () => {
  it("lists open needs, and drops them once resolved", () => {
    expect(needsView.open(db).map((n) => n.needId)).toEqual(["n1", "n2"]);
    store.append(
      d({
        chatId: "c1",
        runId: "r1",
        type: "need.resolved",
        data: { needId: "n1", decision: "allow", by: "you" },
      }),
    );
    expect(needsView.open(db)).toMatchObject([
      { needId: "n2", chatId: "c1", runId: "r1", projectId: "app", kind: "edit" },
    ]);
    expect(needsView.open(db, "other-chat")).toEqual([]);
  });
});

describe("chats view", () => {
  it("tracks title, project, branch, last run status and archiving", () => {
    store.append({
      chatId: "c1",
      runId: "r1",
      origin: "adapter",
      type: "run.finished",
      data: { status: "done" },
    });
    expect(chatsView.list(db)).toEqual([
      {
        chatId: "c1",
        title: "Fix it",
        projectId: "app",
        branch: "ion/fix-it-abc123",
        archived: false,
        lastRunStatus: "done",
      },
    ]);
    expect(chatsView.worktree(db, "c1")).toBe("/w/c1");
  });
});

it("rebuilding from the log gives the same rows", () => {
  const before = [needsView.open(db), chatsView.list(db)];
  store.rebuildViews();
  expect([needsView.open(db), chatsView.list(db)]).toEqual(before);
});
