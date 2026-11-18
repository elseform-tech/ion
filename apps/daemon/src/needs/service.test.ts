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
