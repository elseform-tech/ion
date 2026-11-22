import { EV, type IonEvent, type ToolType } from "@ion/schema";
import { type Step, thinking, toolFinished, toolOutput, toolStarted, workEnded } from "./steps.js";

type Choice = { label: string; consequence: string; recommended?: boolean };

/** How an answer that reaches past the chat is named: the word on the box you ticked. */
export type Keep = "Always" | "Remember";

/** One thing the chat shows, in order. */
export type Item =
  /**
   * gone: your answer to a question, not shown as a message of its own. answers: the question it answers (here),
   * shown as your reply where you sent it, after what the agent said ("Always" when it reaches past the chat).
   */
  | {
      kind: "you";
      text: string;
      gone?: true;
      legacy?: true;
      answers?: string;
      /** Your answer reaches past the chat: "Always" (an agent's question), "Remember" (a call ion stopped). */
      always?: Keep;
      /** What you picked with "/" and "@" (chips). */
      picked?: { skills: string[]; mentions: string[] };
    }
  | { kind: "agent"; text: string; done: boolean }
  | { kind: "work"; runId: string; started: string; ended?: string; steps: Step[] }
  | { kind: "retry"; until: string; done: boolean }
  | { kind: "ion"; tone: "allow" | "deny" | "note"; text: string }
  | {
      kind: "question";
      needId: string;
      question: string;
      why: string | null;
      /** In an ion thread: the project's ion's one line of context. */
      note?: string;
      choices: Choice[];
      /** Closed: answered by you, or its run stopped. */
      resolved?: boolean;
      /** ion's question about a tool call it stopped; expired: ion said no after waiting, the agent went on. */
      blocked?: boolean;
      /** A stopped call whose answer can't be remembered (its input was cut). */
      noRemember?: boolean;
      expired?: boolean;
      answered?: string;
      /** Your answer's message is in the chat: it shows there, where you sent it, not under the question. */
      replied?: true;
      /** Held behind the same question waiting in another thread: settled by that answer. */
      held?: boolean;
      /**
       * How it ended, shown where it was asked: your answer (and "Always" when it reaches past the chat), ion's
       * answer from your decision, or its run stopping first.
       */
      outcome?:
        | { by: "you"; choice: string; always?: Keep }
        | { by: "ion"; text: string }
        | { by: "stopped"; why?: "stopped" | "archived" | "restarted" };
    }
  /** A chat's agent added a connection, skill or hook with ion's commands: it's off until you turn it on. */
  | { kind: "added"; tool: ToolType; name: string }
  /** The chat added a to-do (yours or its project's). */
  | { kind: "todo"; name: string }
  /** A chat saved a preference as a suggestion: you keep it (for every project) in Memory. */
  | { kind: "suggested"; name: string }
  | { kind: "end"; status: string; seconds: number; cost?: number; reason?: string; files?: FileChange[] }
  /** gone: its run ended (done, or failed with it as the reason), so it's not shown on its own. */
  | { kind: "error"; text: string; runId: string; gone?: boolean };

/** The items, plus what the reducer remembers to place later events. */
export type Timeline = {
  items: Item[];
  /** The agent message still streaming, by index. */
  streaming: number | null;
  /** The run that's queued or going, if any. */
  running: string | null;
  /** The agent the chat last ran on, and its model and effort: the next message's defaults. */
  harness: string | null;
  model: string | null;
  effort: string | null;
  /** Grows with every file change and finished run: the changes panel reads again when it moves. */
  changes: number;
  /** Each run's changed files so far, by path (the last counts win), for its end. */
  files: Record<string, Record<string, FileChange>>;
  asks: Record<string, string>;
  work: Record<string, number>;
  tools: Record<string, { at: number; step: number }>;
  questions: Record<string, number>;
  /** ion's questions about stopped calls, by the call's request id. */
  blockedAsks: Record<string, number>;
  /** Your answers in older chats (before ion named the question): their message, when it comes, is under the question. */
  legacy: string[];
  /** Questions whose answer's message named them (newer chats): never matched by label. */
  named: string[];
  started: Record<string, string>;
  cost: Record<string, number>;
};

export const empty = (): Timeline => ({
  items: [],
  streaming: null,
  running: null,
  harness: null,
  model: null,
  effort: null,
  changes: 0,
  files: {},
  asks: {},
  work: {},
  tools: {},
  questions: {},
  blockedAsks: {},
  legacy: [],
  named: [],
  started: {},
  cost: {},
});

type D = Record<string, unknown>;
/** A file a run changed, with its line counts. */
export type FileChange = { path: string; added: number; removed: number };
const str = (x: unknown) => (typeof x === "string" ? x : "");
const push = (t: Timeline, item: Item): Timeline => ({ ...t, items: [...t.items, item], streaming: null });
const replace = (t: Timeline, i: number, item: Item): Timeline => {
  const items = t.items.slice();
  items[i] = item;
  return { ...t, items };
};

function delta(t: Timeline, d: D): Timeline {
  const i = t.streaming;
  const open = i !== null ? t.items[i] : undefined;
  if (open?.kind !== "agent")
    return { ...push(t, { kind: "agent", text: str(d.text), done: false }), streaming: t.items.length };
  return { ...replace(t, i!, { ...open, text: open.text + str(d.text) }), streaming: i };
}

function completed(t: Timeline, d: D): Timeline {
  const i = t.streaming;
  if (i === null) return push(t, { kind: "agent", text: str(d.text), done: true });
  return { ...replace(t, i, { kind: "agent", text: str(d.text), done: true }), streaming: null };
}

/** ion said no to a call it was holding for your answer: its question has gone past its wait. */
function expire(t: Timeline, requestId: string): Timeline {
  const i = t.blockedAsks[requestId];
  const q = i !== undefined ? t.items[i] : undefined;
  return q?.kind === "question" ? replace(t, i!, { ...q, expired: true }) : t;
}

function approval(t: Timeline, d: D): Timeline {
  if (d.by !== "ion") return t;
  const what = str(d.summary) || t.asks[str(d.requestId)] || "a tool";
  // Allows are recorded but not shown: ion lets most things through. A denial shows, with why.
  if (d.decision !== "deny") return t;
  const marked = expire(t, str(d.requestId));
  return push(marked, { kind: "ion", tone: "deny", text: `Denied by ion: ${what} — ${str(d.reason)}` });
}

function question(t: Timeline, d: D): Timeline {
  if (d.kind !== "ask" || !Array.isArray(d.choices)) return t;
  const item: Item = {
    kind: "question",
    needId: str(d.needId),
    question: str(d.summary),
    why: typeof d.detail === "string" ? d.detail : null,
    choices: d.choices as Choice[],
    ...(d.blocked === true ? { blocked: true } : {}),
    ...(d.noRemember === true ? { noRemember: true } : {}),
    ...(typeof (d.via as { note?: unknown } | undefined)?.note === "string"
      ? { note: (d.via as { note: string }).note }
      : {}),
    // Held behind the same question waiting in another thread: settled by that answer, or asked again.
    ...(typeof d.heldFor === "string" ? { resolved: true, held: true } : {}),
  };
  const added = push(t, item);
  const at = added.items.length - 1;
  const blockedAsks = d.blocked === true ? { ...t.blockedAsks, [str(d.requestId)]: at } : t.blockedAsks;
  return { ...added, questions: { ...t.questions, [str(d.needId)]: at }, blockedAsks };
}

type Question = Extract<Item, { kind: "question" }>;
type Outcome = NonNullable<Extract<Item, { kind: "question" }>["outcome"]>;

/** Your answer as the chat shows it under the question: the choice, and "Always" when it reaches past the chat. */
function yours(d: D, blocked?: boolean): Outcome {
  const always = d.scope === "project" || d.scope === "everywhere";
  const word: Keep = blocked ? "Remember" : "Always";
  return { by: "you", choice: str(d.choice), ...(always ? { always: word } : {}) };
}

const STOPPED_WHY = new Set(["stopped", "archived", "restarted"]);

/** Closed without you: why (a held question asked again in the open shows nothing; it's asked again below). */
function closed(t: Timeline, i: number, q: Question, d: D): Timeline {
  if (d.why === "asked again") return { ...replace(t, i, { ...q, resolved: true }), streaming: t.streaming };
  const why = STOPPED_WHY.has(str(d.why)) ? { why: str(d.why) as "stopped" | "archived" | "restarted" } : {};
  return {
    ...replace(t, i, { ...q, resolved: true, outcome: { by: "stopped", ...why } }),
    streaming: t.streaming,
  };
}

function answered(t: Timeline, d: D): Timeline {
  const i = t.questions[str(d.needId)];
  const q = i !== undefined ? t.items[i] : undefined;
  if (q?.kind !== "question") return t;
  // Any answer closes it: yours (with the choice), or its run stopping ("superseded"). A held one is settled by
  // your answer elsewhere: ion's, from that decision.
  if (d.decision !== "answered") return closed(t, i!, q, d);
  const choice = str(d.choice);
  const outcome: Outcome = q.held ? { by: "ion", text: fromYourDecision(choice) } : yours(d, q.blocked);
  const done = {
    ...replace(t, i!, { ...q, resolved: true, answered: choice, outcome }),
    streaming: t.streaming,
  };
  if (!t.named.includes(str(d.needId))) return withLegacy(done, i!, choice);
  return outcome.by === "you" && outcome.always ? alwaysOnReply(done, str(d.needId), outcome.always) : done;
}

/** Your answer's message came first: it says "Always" too, once the answer reaches past the chat. */
function alwaysOnReply(t: Timeline, needId: string, always: Keep): Timeline {
  const at = t.items.findLastIndex((x) => x.kind === "you" && x.answers === needId);
  const reply = t.items[at];
  return reply?.kind === "you" ? replace(t, at, { ...reply, always }) : t;
}

/**
 * Older chats: the answer's message didn't name its question (only ion set `shown`). One already here after the
 * question is hidden; else the next one with that label will be.
 */
function withLegacy(t: Timeline, i: number, choice: string): Timeline {
  const at = t.items.findLastIndex(
    (x, j) => j > i && x.kind === "you" && x.legacy && !x.gone && x.text === choice,
  );
  if (at < 0) return { ...t, legacy: [...t.legacy, choice] };
  return replace(t, at, { kind: "you", text: choice, gone: true });
}

const fromYourDecision = (choice: string) => `Answered by ion from your decision: ${choice}`;

/**
 * Your message. One that answers a question (it names the question) is shown under that question instead, whenever it
 * arrives; a message that merely reads the same is yours like any other.
 */
/** A message's picks, when it had any. */
function pickedOf(d: D) {
  const names = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const picked = { skills: names(d.skills), mentions: names(d.mentions) };
  return picked.skills.length + picked.mentions.length ? { picked } : {};
}

function sent(t: Timeline, d: D): Timeline {
  const shown = str(d.shown);
  const text = shown || str(d.text);
  const answers = str(d.answers);
  if (answers) return answerSent(t, answers, text);
  if (!shown) return push(t, { kind: "you", text, ...pickedOf(d) });
  const at = t.legacy.indexOf(shown);
  if (at < 0) return push(t, { kind: "you", text, legacy: true });
  const pushed = push(t, { kind: "you", text, gone: true });
  return { ...pushed, legacy: t.legacy.filter((_x, j) => j !== at) };
}

/**
 * An answer's message naming its question (when it's here): your reply where you sent it, after the agent's last
 * words (tour, 2026-11-21: they showed after it), its question marked replied; never matched by label.
 */
function answerSent(t0: Timeline, needId: string, text: string): Timeline {
  const here = needId in t0.questions;
  const asked = here ? t0.items[t0.questions[needId]!] : undefined;
  const t = asked?.kind === "question" ? replace(t0, t0.questions[needId]!, { ...asked, replied: true }) : t0;
  const always = asked?.kind === "question" && asked.outcome?.by === "you" ? asked.outcome.always : undefined;
  const reply = { kind: "you" as const, text, ...(here ? { gone: true as const, answers: needId } : {}) };
  const pushed = push(t, always ? { ...reply, always } : reply);
  const q = here ? t.items[t.questions[needId]!] : undefined;
  const label = q?.kind === "question" ? q.answered : undefined;
  const at = label === undefined ? -1 : t.legacy.indexOf(label);
  const legacy = at < 0 ? t.legacy : t.legacy.filter((_x, j) => j !== at);
  return { ...pushed, legacy, named: [...t.named, needId] };
}

/**
 * ion answered from one of your decisions: a question that never reached you shows with what ion answered; one
 * held behind yours elsewhere is settled where it was asked.
 */
function fromDecision(t: Timeline, d: D): Timeline {
  if (d.by !== "ion") return t;
  const text = fromYourDecision(str(d.choice));
  const i = t.questions[str(d.needId)];
  const held = i !== undefined ? t.items[i] : undefined;
  if (held?.kind === "question") return t;
  return push(t, {
    ...{ kind: "question", needId: str(d.needId), question: str(d.question), why: null, choices: [] },
    ...{ resolved: true, outcome: { by: "ion", text } },
  });
}

function finished(t: Timeline, d: D, e: IonEvent): Timeline {
  const runId = e.runId ?? "";
  const from = t.started[runId];
  const seconds = from ? Math.round((Date.parse(e.ts) - Date.parse(from)) / 1000) : 0;
  const cost = t.cost[runId];
  const { t: quiet, last } = errorsGone(workEnded(retried(t), e), runId);
  const ended = push(quiet, {
    kind: "end",
    status: str(d.status),
    seconds,
    ...(cost !== undefined ? { cost } : {}),
    ...(last && str(d.status) === "failed" ? { reason: last } : {}),
    ...(t.files[runId] ? { files: Object.values(t.files[runId]) } : {}),
  });
  return { ...ended, running: t.running === runId ? null : t.running, changes: t.changes + 1 };
}

/** A new try started: any retry still counting down is done. */
const retried = (t: Timeline): Timeline =>
  t.items.some((x) => x.kind === "retry" && !x.done)
    ? { ...t, items: t.items.map((x) => (x.kind === "retry" && !x.done ? { ...x, done: true } : x)) }
    : t;

/** An error, unless it's the same as the run's last one (each retry fails the same way). */
function error(t: Timeline, d: D, e: IonEvent): Timeline {
  const runId = e.runId ?? "";
  const text = str(d.message);
  const same = t.items.findLast((x) => x.kind === "error" && x.runId === runId);
  return same?.kind === "error" && same.text === text ? t : push(t, { kind: "error", text, runId });
}

/** Marks the run's errors gone (its end says what matters), returning the last one's text. */
function errorsGone(t: Timeline, runId: string): { t: Timeline; last: string | null } {
  let last: string | null = null;
  const items = t.items.map((x) => {
    if (x.kind !== "error" || x.runId !== runId || x.gone) return x;
    last = x.text;
    return { ...x, gone: true };
  });
  return { t: last === null ? t : { ...t, items }, last };
}

type Handler = (t: Timeline, d: D, e: IonEvent) => Timeline;

const HANDLERS: Record<string, Handler> = {
  [EV.messageSent]: sent,
  [EV.messageDelta]: delta,
  [EV.messageCompleted]: completed,
  [EV.runQueued]: (t, _d, e) => ({ ...t, running: e.runId }),
  [EV.runStarted]: (t, d, e) => ({
    ...retried(t),
    running: e.runId,
    harness: str(d.harness) || t.harness,
    model: str(d.model) || null,
    effort: str(d.effort) || null,
    started: { ...t.started, [e.runId ?? ""]: e.ts },
  }),
  [EV.toolStarted]: toolStarted,
  [EV.thinkingDelta]: thinking,
  [EV.toolFinished]: toolFinished,
  [EV.toolOutput]: toolOutput,
  [EV.fileChanged]: (t, d, e) => {
    const runId = e.runId ?? "";
    const change = { path: str(d.path), added: Number(d.added) || 0, removed: Number(d.removed) || 0 };
    // Each change is one edit's counts: a file edited three times adds all three.
    const was = t.files[runId]?.[change.path];
    const sum = was
      ? { ...change, added: was.added + change.added, removed: was.removed + change.removed }
      : change;
    const files = { ...t.files, [runId]: { ...t.files[runId], [change.path]: sum } };
    return { ...t, changes: t.changes + 1, files };
  },
  [EV.approvalRequested]: (t, d) => ({ ...t, asks: { ...t.asks, [str(d.requestId)]: str(d.summary) } }),
  [EV.approvalResolved]: approval,
  [EV.needRaised]: question,
  [EV.needResolved]: answered,
  [EV.decisionRecorded]: fromDecision,
  [EV.usageReported]: (t, d, e) =>
    typeof d.costUsd === "number" ? { ...t, cost: { ...t.cost, [e.runId ?? ""]: d.costUsd } } : t,
  // A retry counts down to when it starts; it's gone once it has.
  [EV.runRetrying]: (t, d, e) =>
    push(t, {
      kind: "retry",
      until: new Date(Date.parse(e.ts) + (Number(d.delayS) || 0) * 1000).toISOString(),
      done: false,
    }),
  [EV.runFinished]: finished,
  [EV.error]: error,
  // A run went without one of your MCP servers: ion says why, once per chat.
  [EV.toolSkipped]: (t, d) => push(t, { kind: "ion", tone: "note", text: str(d.text) }),
  [EV.toolAdded]: (t, d) => push(t, { kind: "added", tool: d.kind as ToolType, name: str(d.name) }),
  // A chat's preference waits for you to keep it (security review, 2026-11-22): the chat says so, once, with a link
  // to Memory (Task 5, 2026-11-22: a question here had no answer).
  // A to-do it added: one quiet line with a link to your to-dos.
  [EV.memoryWritten]: (t, d) => {
    const h = (d.header ?? {}) as { name?: unknown; suggested?: unknown; type?: unknown };
    if (d.before) return t;
    if (h.type === "todo") return push(t, { kind: "todo", name: str(h.name) });
    return h.suggested ? push(t, { kind: "suggested", name: str(h.name) }) : t;
  },
};

/** Adds one event to the chat's timeline. Pure: the same events always give the same items. */
export function reduce(t: Timeline, e: IonEvent): Timeline {
  const h = HANDLERS[e.type];
  return h ? h(t, e.data as D, e) : t;
}
