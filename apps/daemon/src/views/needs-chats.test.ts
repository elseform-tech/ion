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
        lastActivityAt: expect.any(String),
        preview: null,
        by: null,
      },
    ]);
    expect(chatsView.worktree(db, "c1")).toBe("/w/c1");
  });
});

// Plan 08: the sidebar sorts and labels chats by their last activity.
describe("chats view, activity", () => {
  it("keeps when each chat last had a message or a run", () => {
    const at = chatsView.list(db).find((c) => c.chatId === "c1")?.lastActivityAt;
    expect(typeof at).toBe("string");
    const before = Date.parse(at!);
    store.append(d({ chatId: "c1", runId: "r2", type: "message.sent", data: { text: "again" } }));
    const after = chatsView.list(db).find((c) => c.chatId === "c1")!.lastActivityAt!;
    expect(Date.parse(after)).toBeGreaterThanOrEqual(before);
  });
});

// UX tour: a sidebar row shows the start of the agent's last reply under the title.
describe("chats view, preview", () => {
  // Security review: an agent's text can't bring terminal escapes or bidi tricks into the sidebar or the CLI.
  it("strips control and bidi characters from the preview", () => {
    const text = "ok\u001b[31m red\u202e evil\u0007 end";
    store.append(
      d({ chatId: "c1", runId: "r4", type: "message.completed", data: { messageId: "m2", text } }),
    );
    expect(chatsView.list(db).find((c) => c.chatId === "c1")?.preview).toBe("ok[31m red evil end");
  });

  it("keeps the start of the agent's last reply, on one line", () => {
    const text = `Done.\n\nI changed **three** files and ran the tests; ${"all green ".repeat(20)}`;
    store.append(
      d({ chatId: "c1", runId: "r3", type: "message.completed", data: { messageId: "m1", text } }),
    );
    const preview = chatsView.list(db).find((c) => c.chatId === "c1")?.preview ?? "";
    expect(preview.startsWith("Done. I changed three files and ran the tests;")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(120);
  });
});

it("rebuilding from the log gives the same rows", () => {
  const before = [needsView.open(db), chatsView.list(db)];
  store.rebuildViews();
  expect([needsView.open(db), chatsView.list(db)]).toEqual(before);
});
