import type { NewEvent } from "@ion/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { type Db, EventStore, openDb } from "../store/index.js";
import { chatsView } from "./chats.js";
import { allViews } from "./index.js";
import { messagesView } from "./messages.js";

let db: Db;
let store: EventStore;
type Put = { chatId: string; runId: string | null; type: string; data: object; origin?: NewEvent["origin"] };
const put = ({ origin = "daemon", ...e }: Put) => store.append({ ...e, origin } as NewEvent);
const started = (chatId: string, runId: string, sessionId: string) =>
  put({
    chatId,
    runId,
    type: "run.started",
    data: { harness: "fake", model: "m", effort: null, authMethod: null, sessionId },
    origin: "adapter",
  });

beforeEach(() => {
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
  put({ chatId: "c1", runId: null, type: "chat.created", data: { title: "One", projectId: "app" } });
  put({ chatId: "c2", runId: null, type: "chat.created", data: { title: "Two", projectId: "shop" } });
  put({ chatId: "c1", runId: "r1", type: "message.sent", data: { text: "Remember the word kiwi" } });
  started("c1", "r1", "s-1");
  put({
    chatId: "c1",
    runId: "r1",
    type: "message.completed",
    data: { text: "Got it: kiwi." },
    origin: "adapter",
  });
  put({ chatId: "c2", runId: "r2", type: "message.sent", data: { text: "kiwi in the shop" } });
  put({ chatId: "c1", runId: "r3", type: "message.sent", data: { text: "What word?" } });
  started("c1", "r3", "s-2");
});

describe("messagesView", () => {
  it("keeps a chat's messages in order, yours and the agent's", () => {
    expect(messagesView.history(db, "c1", 10_000)).toEqual([
      { role: "you", text: "Remember the word kiwi" },
      { role: "agent", text: "Got it: kiwi." },
      { role: "you", text: "What word?" },
    ]);
  });

  it("keeps the newest whole messages within the character limit", () => {
    expect(messagesView.history(db, "c1", 25)).toEqual([
      { role: "agent", text: "Got it: kiwi." },
      { role: "you", text: "What word?" },
    ]);
  });

  it("searches one project's messages only", () => {
    const hits = messagesView.search(db, "app", "kiwi", 20);
    expect(hits.map((h) => h.chatId)).toEqual(["c1", "c1"]);
    expect(messagesView.search(db, "shop", "kiwi", 20).map((h) => h.text)).toEqual(["kiwi in the shop"]);
  });

  // Final review minor 2: the newest matches come first.
  it("returns the newest matches first", () => {
    put({ chatId: "c1", runId: "r4", type: "message.sent", data: { text: "kiwi again" } });
    expect(messagesView.search(db, "app", "kiwi", 1).map((h) => h.text)).toEqual(["kiwi again"]);
  });

  it("treats search text as words, not a query language", () => {
    expect(() => messagesView.search(db, "app", 'kiwi" OR "*', 20)).not.toThrow();
  });
});

describe("chatsView.session", () => {
  it("is the harness and session id of the chat's last run", () => {
    expect(chatsView.session(db, "c1")).toEqual({ harness: "fake", sessionId: "s-2" });
    expect(chatsView.session(db, "c2")).toBeNull();
  });
});

it("rebuilds the same rows from the log", () => {
  const before = [messagesView.history(db, "c1", 10_000), chatsView.session(db, "c1")];
  store.rebuildViews();
  expect([messagesView.history(db, "c1", 10_000), chatsView.session(db, "c1")]).toEqual(before);
});
