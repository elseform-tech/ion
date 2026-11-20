import { EV } from "@ion/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { UserError } from "../api/errors.js";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { NeedsService } from "./service.js";

let db: Db;
let store: EventStore;
let needs: NeedsService;
const question = {
  chatId: "c1",
  runId: "r1",
  question: "Use Postgres?",
  choices: [
    { label: "Yes", consequence: "Adds a database" },
    { label: "No", consequence: "Stays on SQLite" },
  ],
};

beforeEach(() => {
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
  store.append({
    chatId: "c1",
    runId: null,
    origin: "daemon",
    type: EV.chatCreated,
    data: { title: "t", projectId: "app" },
  });
  needs = new NeedsService(store, db);
});

describe("NeedsService", () => {
  it("raises a question and answers it once", () => {
    const id = needs.raiseAsk(question);
    expect(needs.open()).toMatchObject([
      { needId: id, kind: "ask", projectId: "app", choices: question.choices },
    ]);
    needs.answered(id, "Yes", "project");
    expect(needs.open()).toEqual([]);
    expect(() => needs.answered(id, "No", "chat")).toThrow(new UserError("That's already answered"));
    expect(() => needs.openNeed("nope")).toThrow(new UserError("Unknown need: nope"));
  });

  // An old permission need left open by an older ion is superseded when its run stops; questions aren't.
  it("supersedes a stopped run's old needs, and keeps its questions", () => {
    store.append({
      chatId: "c1",
      runId: "r1",
      origin: "daemon",
      type: EV.needRaised,
      data: { needId: "old", requestId: "q1", kind: "command", summary: "x", detail: null, dedupeKey: "k" },
    });
    needs.raiseAsk(question);
    needs.supersedeRun("r1");
    expect(needs.open().map((n) => n.kind)).toEqual(["ask"]);
    expect(() => needs.openNeed("old")).toThrow(new UserError("That run stopped"));
  });

  // Real run on Grok, 2026-11-19: "Allow this?" about a call ion stopped stayed open after the thread finished, so
  // its ion's line read "Waiting for you" on a finished thread. The call is gone with its run: so is the question.
  it("closes a stopped call's question when its run ends, and keeps the agent's own questions", () => {
    needs.raiseAsk({ ...question, question: "Allow this? grep", blocked: { requestId: "g1" } });
    needs.raiseAsk(question);
    needs.supersedeRun("r1");
    expect(needs.open().map((n) => n.summary)).toEqual(["Use Postgres?"]);
  });

  // Same run: questions about stopped calls left open by an older ion close when ion starts (no call still waits).
  it("closes, at the start, every question about a stopped call", () => {
    needs.raiseAsk({ ...question, question: "Allow this? grep", blocked: { requestId: "g1" } });
    needs.raiseAsk(question);
    needs.supersedeStoppedCalls();
    expect(needs.open().map((n) => n.summary)).toEqual(["Use Postgres?"]);
  });

  // Plan 06, Global Constraints: an old allow/deny answer still reads.
  it("still reads old allow and deny answers", () => {
    store.append({
      chatId: "c1",
      runId: "r1",
      origin: "daemon",
      type: EV.needRaised,
      data: { needId: "old", requestId: "q1", kind: "command", summary: "x", detail: null, dedupeKey: "k" },
    });
    store.append({
      chatId: "c1",
      runId: "r1",
      origin: "daemon",
      type: EV.needResolved,
      data: { needId: "old", decision: "allow", by: "you" },
    });
    expect(needs.open()).toEqual([]);
  });
});
