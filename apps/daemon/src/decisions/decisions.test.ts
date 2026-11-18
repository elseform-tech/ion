import { EV, type IonEvent } from "@ion/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserError } from "../api/errors.js";
import { NeedsService } from "../needs/index.js";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { createMatcher, Decisions, type Matcher, matchPrompt, parseMatch } from "./index.js";

let db: Db;
let store: EventStore;
let needs: NeedsService;
let followUp: ReturnType<typeof vi.fn>;
let seen: IonEvent[];

const q = {
  question: "Delete the build folder?",
  choices: [
    { label: "Delete it", consequence: "build/ is removed" },
    { label: "Keep it", consequence: "Nothing changes" },
  ],
  why: "It's 2 GB of old output",
};
const scope = (chatId = "c1", runId = "r1", projectId = "app") => ({ projectId, chatId, runId });

function chat(chatId: string, projectId = "app") {
  store.append({
    chatId,
    runId: null,
    origin: "daemon",
    type: EV.chatCreated,
    data: { title: "t", projectId },
  });
}
function startRun(chatId: string, runId: string) {
  store.append({ chatId, runId, origin: "daemon", type: EV.runQueued, data: {} });
  store.append({
    chatId,
    runId,
    origin: "adapter",
    type: EV.runStarted,
    data: { harness: "fake", model: "fake", effort: null, authMethod: "Fake", sessionId: "s" },
  });
}
const make = (match?: Matcher) =>
  new Decisions({
    store,
    db,
    needs,
    followUp,
    requestOf: (runId) => (runId === "r1" ? "Tidy the repo" : null),
    ...(match ? { match } : {}),
  });

beforeEach(() => {
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
  needs = new NeedsService(store, db);
  seen = [];
  store.onAppend((e) => seen.push(e));
  followUp = vi.fn(async () => "r2");
  chat("c1");
  chat("c2");
  chat("o1", "other");
  startRun("c1", "r1");
});

const of = (type: string) =>
  seen.filter((e) => e.type === type).map((e) => e.data as Record<string, unknown>);

describe("ask", () => {
  it("raises a question with its choices, and tells the agent to end its turn", async () => {
    expect(await make().ask(scope(), q)).toBe(
      "Asked. End your turn now; the answer comes as the next message.",
    );
    expect(needs.open("c1")).toMatchObject([
      {
        kind: "ask",
        summary: "Delete the build folder?",
        detail: "It's 2 GB of old output",
        choices: q.choices,
      },
    ]);
  });

  it("keeps the question open when the run that asked ends", async () => {
    await make().ask(scope(), q);
    needs.supersedeRun("r1");
    expect(needs.open("c1")).toHaveLength(1);
  });
});

describe("answer", () => {
  it("stores your answer as a decision and sends it into the chat", async () => {
    const d = make();
    await d.ask(scope(), q);
    const [need] = needs.open("c1");
    await d.answer(need!.needId, 1, "project");
    expect(of(EV.needResolved).at(-1)).toMatchObject({
      decision: "answered",
      choice: "Delete it",
      scope: "project",
    });
    expect(of(EV.decisionRecorded).at(-1)).toMatchObject({
      projectId: "app",
      question: "Delete the build folder?",
      choice: "Delete it",
      scope: "project",
      by: "you",
    });
    // Security review: the judge keeps judging by what you asked, never the agent's question.
    expect(followUp).toHaveBeenCalledWith(
      "c1",
      "fake",
      'You asked: "Delete the build folder?". The user chose: "Delete it".',
      "Tidy the repo",
    );
    // RF3: a second answer is refused.
    await expect(d.answer(need!.needId, 2)).rejects.toThrow("That's already answered");
  });

  it("refuses a choice that isn't there", async () => {
    const d = make();
    await d.ask(scope(), q);
    await expect(d.answer(needs.open("c1")[0]!.needId, 3)).rejects.toThrow("Pick 1 to 2");
  });

  it("records what happened: the run after your answer ran or failed", async () => {
    const d = make();
    await d.ask(scope(), q);
    await d.answer(needs.open("c1")[0]!.needId, 1);
    store.append({
      chatId: "c1",
      runId: "r2",
      origin: "daemon",
      type: EV.runFinished,
      data: { status: "done" },
    });
    expect(of(EV.decisionOutcome).at(-1)).toMatchObject({ kind: "ran", by: "ion" });
  });

  it("works after a restart (a new service over the same store)", async () => {
    await make().ask(scope(), q);
    await make().answer(needs.open("c1")[0]!.needId, 2);
    expect(of(EV.decisionRecorded).at(-1)).toMatchObject({ choice: "Keep it" });
  });
});

describe("answered by ion", () => {
  async function decided(where: "chat" | "project" | "everywhere") {
    const d = make();
    await d.ask(scope(), q);
    await d.answer(needs.open("c1")[0]!.needId, 1, where);
  }

  it("answers from an 'always' decision when the matcher picks one of the new choices exactly", async () => {
    await decided("project");
    const match = vi.fn(async () => ({
      decisionId: String(of(EV.decisionRecorded)[0]!.decisionId),
      label: "Delete it",
    }));
    const text = await make(match).ask(scope("c2", "r9"), q);
    expect(text).toMatch(/^The user already decided: "Delete it"/);
    expect(of(EV.decisionRecorded).at(-1)).toMatchObject({
      by: "ion",
      choice: "Delete it",
      fromDecision: expect.any(String),
    });
    expect(needs.open("c2")).toEqual([]);
  });

  // Security review: ion answers only with the very label you picked, and at most 3 times a run.
  it("answers only with the label you picked before, at most 3 times a run", async () => {
    await decided("project");
    const id = String(of(EV.decisionRecorded)[0]!.decisionId);
    const other = {
      ...q,
      choices: [
        { label: "Keep it", consequence: "x" },
        { label: "Bin it", consequence: "y" },
      ],
    };
    expect(
      await make(async () => ({ decisionId: id, label: "Keep it" })).ask(scope("c2", "r9"), other),
    ).toMatch(/^Asked\./);
    const d = make(async () => ({ decisionId: id, label: "Delete it" }));
    for (let i = 0; i < 3; i++)
      expect(await d.ask(scope("c2", "r7"), q)).toMatch(/^The user already decided/);
    expect(await d.ask(scope("c2", "r7"), q)).toMatch(/^Asked\./);
  });

  // RF4: a loose fit goes to you.
  it("asks you when the matcher's label isn't one of the new choices", async () => {
    await decided("project");
    const match = vi.fn(async () => ({
      decisionId: String(of(EV.decisionRecorded)[0]!.decisionId),
      label: "Remove",
    }));
    expect(await make(match).ask(scope("c2", "r9"), q)).toMatch(/^Asked\./);
    expect(needs.open("c2")).toHaveLength(1);
  });

  it("never uses a this-chat-only decision elsewhere, nor another project's", async () => {
    await decided("chat");
    const match = vi.fn(async () => null);
    await make(match).ask(scope("c2", "r9"), q);
    await make(match).ask(scope("o1", "r8", "other"), q);
    expect(match).not.toHaveBeenCalled();
  });
});

describe("decisions for the judge, notes and forgetting", () => {
  it("gives the newest decisions that apply, and drops forgotten ones", async () => {
    const d = make();
    await d.ask(scope(), q);
    await d.answer(needs.open("c1")[0]!.needId, 1, "everywhere");
    const id = String(of(EV.decisionRecorded)[0]!.decisionId);
    expect(d.forJudge("other", "o1")).toEqual(['"Delete the build folder?" → "Delete it" (everywhere)']);
    d.forget(id);
    expect(d.forJudge("other", "o1")).toEqual([]);
    // Security review: only your own decisions reach the judge, never ion's answers from them.
    await d.ask(scope(), q);
    await d.answer(needs.open("c1")[0]!.needId, 1, "project");
    const from = String(of(EV.decisionRecorded).at(-1)!.decisionId);
    await make(async () => ({ decisionId: from, label: "Delete it" })).ask(scope(), q);
    expect(of(EV.decisionRecorded).at(-1)).toMatchObject({ by: "ion" });
    expect(d.forJudge("app", "c1")).toHaveLength(1);
  });

  it("takes at most 3 outcomes from an agent per run, and your notes", async () => {
    const d = make();
    await d.ask(scope(), q);
    await d.answer(needs.open("c1")[0]!.needId, 1);
    const id = String(of(EV.decisionRecorded)[0]!.decisionId);
    for (let i = 0; i < 3; i++) d.report(scope(), id, `went fine ${i}`);
    expect(() => d.report(scope(), id, "again")).toThrow("That's enough outcomes for one run");
    d.note(id, "That was a mistake");
    expect(of(EV.decisionOutcome).at(-1)).toMatchObject({
      kind: "note",
      by: "you",
      text: "That was a mistake",
    });
    expect(() => d.report(scope("o1", "r8", "other"), id, "x")).toThrow("Not allowed");
    // Security review: an "everywhere" decision from another project isn't another project's agent's to annotate.
    await d.ask(scope(), q);
    await d.answer(needs.open("c1")[0]!.needId, 1, "everywhere");
    const everywhere = String(of(EV.decisionRecorded).at(-1)!.decisionId);
    expect(() => d.report(scope("o1", "r8", "other"), everywhere, "x")).toThrow("Not allowed");
  });
});

describe("matcher", () => {
  const past = [
    {
      decisionId: "d1",
      projectId: "app",
      chatId: "c1",
      question: "Remove build/?",
      choice: "Yes",
      scope: "project" as const,
      by: "you" as const,
      decidedAt: "2026-11-18T10:00:00Z",
      outcomes: [],
    },
  ];

  it("labels the question and past decisions as data", () => {
    const p = matchPrompt(q, past);
    expect(p).toMatch(/<ion-data id="\w+" source="the new question">/);
    expect(p).toMatch(/<ion-data id="\w+" source="your decisions">/);
  });

  it("reads only a whole-JSON answer naming a past decision and one of the new labels", () => {
    expect(parseMatch('{"decisionId": "d1", "label": "Delete it"}', past)).toEqual({
      decisionId: "d1",
      label: "Delete it",
    });
    expect(parseMatch('{"decisionId": "nope", "label": "Delete it"}', past)).toBeNull();
    expect(parseMatch('{"none": true}', past)).toBeNull();
    expect(parseMatch('Sure: {"decisionId": "d1", "label": "Delete it"}', past)).toBeNull();
  });

  it("treats a failing model as no match", async () => {
    const m = createMatcher(async () => {
      throw new Error("down");
    });
    expect(await m(q, past)).toBeNull();
  });
});

// Final review (Plan 06), finding 2: an answer is never lost.
describe("answers that can't go straight back", () => {
  it("keeps the question open when the follow-up can't start, so you can answer again", async () => {
    const d = make();
    await d.ask(scope(), q);
    const id = needs.open("c1")[0]!.needId;
    followUp.mockRejectedValueOnce(new UserError("opencode isn't signed in. Run: opencode auth login"));
    await expect(d.answer(id, 1)).rejects.toThrow("opencode isn't signed in");
    expect(needs.open("c1")).toHaveLength(1);
    expect(of(EV.decisionRecorded)).toEqual([]);
    await d.answer(id, 1);
    expect(of(EV.decisionRecorded)).toHaveLength(1);
  });

  it("sends every answer given while the chat is busy, in order, once its run ends", async () => {
    const d = make();
    await d.ask(scope(), q);
    await d.ask(scope(), { ...q, question: "Also clean dist?" });
    followUp.mockRejectedValueOnce(new UserError("This chat is already running"));
    const [a, b] = needs.open("c1");
    await d.answer(a!.needId, 1);
    await d.answer(b!.needId, 2);
    store.append({
      chatId: "c1",
      runId: "r1",
      origin: "daemon",
      type: EV.runFinished,
      data: { status: "done" },
    });
    // The second answer waits behind the first without trying; both go once the run ends, in order.
    await until(() => followUp.mock.calls.length === 3);
    expect(followUp.mock.calls.slice(1).map((c) => c[2])).toEqual([
      'You asked: "Delete the build folder?". The user chose: "Delete it".',
      'You asked: "Also clean dist?". The user chose: "Keep it".',
    ]);
  });

  it("sends answers still waiting when ion stopped, once it starts again", async () => {
    const d = make();
    await d.ask(scope(), q);
    followUp.mockRejectedValueOnce(new UserError("This chat is already running"));
    await d.answer(needs.open("c1")[0]!.needId, 2);
    // ion stops before the chat's run ends; a new ion picks the answer up.
    followUp.mockClear();
    await make().resume();
    expect(followUp).toHaveBeenCalledWith(
      "c1",
      "fake",
      'You asked: "Delete the build folder?". The user chose: "Keep it".',
      "",
    );
    followUp.mockClear();
    const text = 'You asked: "Delete the build folder?". The user chose: "Keep it".';
    store.append({ chatId: "c1", runId: "r2", origin: "daemon", type: EV.messageSent, data: { text } });
    await make().resume();
    expect(followUp).not.toHaveBeenCalled();
  });
});

// Final review (Plan 06), finding 3: a past answer only stands in for a question worded much the same.
describe("answered by ion, only for the same question", () => {
  it("asks you when the new question is about something else, and names the question it matched", async () => {
    const d = make();
    await d.ask(scope(), q);
    await d.answer(needs.open("c1")[0]!.needId, 1, "project");
    const id = String(of(EV.decisionRecorded)[0]!.decisionId);
    const match = async () => ({ decisionId: id, label: "Delete it" });
    expect(
      await make(match).ask(scope("c2", "r9"), { ...q, question: "Drop and recreate the prod database?" }),
    ).toMatch(/^Asked\./);
    expect(
      await make(match).ask(scope("c2", "r8"), { ...q, question: "Should I delete the build folder?" }),
    ).toBe('The user already decided: "Delete it" when asked "Delete the build folder?". Go ahead.');
  });
});

async function until(f: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
