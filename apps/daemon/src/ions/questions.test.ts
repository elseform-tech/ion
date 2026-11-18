import { EV, type IonEvent } from "@ion/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Decisions, type Matcher } from "../decisions/index.js";
import { NeedsService } from "../needs/index.js";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { IonQuestions } from "./questions.js";

let db: Db;
let store: EventStore;
let needs: NeedsService;
let followUp: ReturnType<typeof vi.fn>;
let same: ReturnType<typeof vi.fn>;
let seen: IonEvent[];

const q = (question = "Use the QA account for staging?") => ({
  question,
  choices: [
    { label: "Use QA account", consequence: "Logs in as qa@" },
    { label: "Skip", consequence: "No staging test" },
  ],
});
const scope = (chatId: string, runId = `r-${chatId}`) => ({ projectId: "storefront", chatId, runId });

function chat(chatId: string, by?: "ion") {
  store.append({
    chatId,
    runId: null,
    origin: "daemon",
    type: EV.chatCreated,
    data: { title: chatId, projectId: "storefront", ...(by ? { by } : {}) },
  });
  store.append({ chatId, runId: `r-${chatId}`, origin: "daemon", type: EV.runQueued, data: {} });
  store.append({
    chatId,
    runId: `r-${chatId}`,
    origin: "adapter",
    type: EV.runStarted,
    data: { harness: "fake", model: "fake", effort: null, authMethod: null, sessionId: "s" },
  });
}
const make = (match?: Matcher) =>
  new Decisions({
    store,
    db,
    needs,
    followUp,
    ion: new IonQuestions({ store, db, needs, same }),
    ...(match ? { match } : {}),
  });
const ionSaid = () =>
  seen.filter((e) => e.type === EV.ionSaid).map((e) => e.data as { text: string; card?: { kind: string } });
const open = (chatId: string) => needs.open(chatId);

beforeEach(() => {
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
  needs = new NeedsService(store, db);
  seen = [];
  store.onAppend((e) => seen.push(e));
  followUp = vi.fn(async () => "r2");
  same = vi.fn(async () => null);
  chat("t1", "ion");
  chat("t2", "ion");
  chat("mine");
});

// Plan 09: in threads ion started, questions go through the project's ion first.
describe("questions in ion threads", () => {
  it("are answered from any decision you made in the project, and the ion says so", async () => {
    const d = make();
    await d.ask(scope("t1"), q());
    await d.answer(open("t1")[0]!.needId, 1, "chat");
    const match: Matcher = async (_q, past) => ({ decisionId: past[0]!.decisionId, label: "Use QA account" });
    const reply = await make(match).ask(scope("t2"), q());
    expect(reply).toContain("The user already decided");
    expect(ionSaid().at(-1)?.text).toBe(
      'Answered "Use the QA account for staging?" with "Use QA account" from your decision.',
    );
  });

  // Security review: a decision you kept to one of your own chats never answers for an ion thread.
  it("never use a decision you kept to one of your own chats", async () => {
    const d = make();
    await d.ask(scope("mine"), q());
    await d.answer(open("mine")[0]!.needId, 1, "chat");
    const match: Matcher = vi.fn(async (_q, past) =>
      past[0] ? { decisionId: past[0].decisionId, label: "Use QA account" } : null,
    );
    await make(match).ask(scope("t1"), q());
    expect(open("t1")).toHaveLength(1);
  });

  // Review Focus 1.
  it("leave your own chats alone: no ion answer from a chat-only decision, and no note", async () => {
    const d = make();
    await d.ask(scope("t1"), q());
    await d.answer(open("t1")[0]!.needId, 1, "chat");
    const match: Matcher = vi.fn(async (_q, past) =>
      past[0] ? { decisionId: past[0].decisionId, label: "Use QA account" } : null,
    );
    await make(match).ask(scope("mine"), q());
    expect(open("mine")).toHaveLength(1);
    expect(seen.find((e) => e.type === EV.needRaised && e.chatId === "mine")?.data).not.toHaveProperty("via");
  });

  it("come to you with the ion's note", async () => {
    await make().ask(scope("t1"), q());
    expect(seen.find((e) => e.type === EV.needRaised && e.chatId === "t1")?.data).toMatchObject({
      via: { note: "storefront's ion: first time this comes up" },
    });
  });

  // Review Focus 3.
  it("hold a question already waiting in another thread, and settle it with your one answer", async () => {
    const d = make();
    await d.ask(scope("t1"), q());
    const first = open("t1")[0]!.needId;
    same.mockResolvedValueOnce(first);
    await d.ask(scope("t2"), q());
    expect(open("t2")).toEqual([]);
    await d.answer(first, 1, "chat");
    expect(followUp).toHaveBeenCalledWith("t2", expect.objectContaining({ shown: "Use QA account" }));
  });

  // Security review: only an identical question (wording and choices) is settled by your answer; one the model
  // merely thought alike is raised to you instead.
  it("raise a held question to you when it isn't the very same question", async () => {
    const d = make();
    await d.ask(scope("t1"), q());
    const first = open("t1")[0]!.needId;
    same.mockResolvedValueOnce(first);
    await d.ask(scope("t2"), q("Use the QA account for production too?"));
    await d.answer(first, 1, "chat");
    expect(followUp).not.toHaveBeenCalledWith("t2", expect.anything());
    expect(open("t2").map((n) => n.summary)).toEqual(["Use the QA account for production too?"]);
  });

  it("raise a held question to you when the one it waited for closes another way", async () => {
    const d = make();
    await d.ask(scope("t1"), q());
    const first = open("t1")[0]!.needId;
    same.mockResolvedValueOnce(first);
    await d.ask(scope("t2"), q());
    store.append({
      chatId: "t1",
      runId: "r-t1",
      origin: "daemon",
      type: EV.needResolved,
      data: { needId: first, decision: "superseded", by: "daemon" },
    });
    expect(open("t2").map((n) => n.summary)).toEqual(["Use the QA account for staging?"]);
  });

  it("suggest 'always' after you give the same answer three times, and keep it as a project decision", async () => {
    const d = make();
    for (const t of ["t1", "t2", "t1"]) {
      await d.ask(scope(t), q());
      await d.answer(open(t)[0]!.needId, 1, "chat");
    }
    const card = ionSaid().find((x) => x.card?.kind === "suggest")?.card as { suggestionId: string };
    expect(card).toMatchObject({
      kind: "suggest",
      question: "Use the QA account for staging?",
      choice: "Use QA account",
    });
    d.suggestion(card.suggestionId, true);
    expect(seen.filter((e) => e.type === EV.decisionRecorded).at(-1)?.data).toMatchObject({
      scope: "project",
      choice: "Use QA account",
      by: "you",
    });
  });

  it("flag a decision whose runs failed twice", async () => {
    const d = make();
    await d.ask(scope("t1"), q());
    await d.answer(open("t1")[0]!.needId, 1, "chat");
    const decisionId = (
      seen.filter((e) => e.type === EV.decisionRecorded).at(-1)!.data as { decisionId: string }
    ).decisionId;
    for (const runId of ["x1", "x2"])
      store.append({
        chatId: "t1",
        runId,
        origin: "daemon",
        type: EV.decisionOutcome,
        data: { decisionId, kind: "failed", text: "Failed", by: "ion" },
      });
    expect(ionSaid().find((x) => x.card?.kind === "flag")).toMatchObject({
      card: { kind: "flag", decisionId, failed: 2, choice: "Use QA account" },
    });
  });
  // Final review C1: answered while ion was still comparing: the new question isn't held behind a closed one.
  it("never holds a question behind one you answered while ion compared them", async () => {
    const d = make();
    await d.ask(scope("t1"), q());
    const first = open("t1")[0]!.needId;
    let compare: (id: string | null) => void = () => {};
    same.mockImplementationOnce(() => new Promise((r) => (compare = r)));
    const asking = d.ask(scope("t2"), q());
    await vi.waitFor(() => expect(same).toHaveBeenCalled());
    await d.answer(first, 1, "chat");
    compare(first);
    await asking;
    expect(open("t2").map((n) => n.summary)).toEqual(["Use the QA account for staging?"]);
  });

  // Final review C1: after a restart (or anything that left it), a question held behind a closed one is raised.
  it("raises held questions whose question closed, when swept", async () => {
    const d = make();
    await d.ask(scope("t1"), q());
    const first = open("t1")[0]!.needId;
    same.mockResolvedValueOnce(first);
    await d.ask(scope("t2"), q());
    // ion stopped right after recording your answer, before settling the held one:
    store.append({
      chatId: "t1",
      runId: "r-t1",
      origin: "daemon",
      type: EV.needResolved,
      data: { needId: first, decision: "answered", by: "you", choice: "Use QA account", scope: "chat" },
    });
    new IonQuestions({ store, db, needs, same }).sweep();
    expect(open("t2")).toHaveLength(1);
  });

  // Final review I4: your own chats' answers never reach ion's notes, suggestions or flags.
  it("keeps your own chats' answers out of ion's notes, suggestions and flags", async () => {
    const d = make();
    for (let i = 0; i < 3; i++) {
      await d.ask(scope("mine", `rm${i}`), q());
      await d.answer(open("mine")[0]!.needId, 1, "chat");
    }
    await d.ask(scope("t1"), q());
    expect(seen.filter((e) => e.type === EV.needRaised && e.chatId === "t1").at(-1)?.data).toMatchObject({
      via: { note: "storefront's ion: first time this comes up" },
    });
    expect(ionSaid().some((x) => x.card?.kind === "suggest")).toBe(false);
    const mineDecision = (
      seen.find((e) => e.type === EV.decisionRecorded && e.chatId === "mine")!.data as { decisionId: string }
    ).decisionId;
    for (const runId of ["x1", "x2"])
      store.append({
        chatId: "mine",
        runId,
        origin: "daemon",
        type: EV.decisionOutcome,
        data: { decisionId: mineDecision, kind: "failed", text: "Failed", by: "ion" },
      });
    expect(ionSaid().some((x) => x.card?.kind === "flag")).toBe(false);
  });

  // Final review I5: questions settled by your one answer are ion's doing, not three answers of yours.
  it("counts only your own answers toward 'Always?'", async () => {
    const d = make();
    await d.ask(scope("t1"), q());
    const first = open("t1")[0]!.needId;
    chat("t3", "ion");
    same.mockResolvedValueOnce(first).mockResolvedValueOnce(first);
    await d.ask(scope("t2"), q());
    await d.ask(scope("t3"), q());
    await d.answer(first, 1, "chat");
    expect(ionSaid().some((x) => x.card?.kind === "suggest")).toBe(false);
    expect(
      seen.filter((e) => e.type === EV.decisionRecorded).map((e) => (e.data as { by: string }).by),
    ).toEqual(["you", "ion", "ion"]);
  });
});
