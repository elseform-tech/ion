import { EV, type IonEvent } from "@ion/schema";
import { type Step, thinking, toolFinished, toolOutput, toolStarted, workEnded } from "./steps.js";

type Choice = { label: string; consequence: string; recommended?: boolean };

/** One thing the chat shows, in order. */
export type Item =
  | { kind: "you"; text: string }
  | { kind: "agent"; text: string; done: boolean }
  | { kind: "work"; runId: string; started: string; ended?: string; steps: Step[] }
  | { kind: "retry"; until: string; done: boolean }
  | { kind: "ion"; tone: "allow" | "deny" | "answer" | "note"; text: string }
  | {
      kind: "question";
      needId: string;
      question: string;
      why: string | null;
      choices: Choice[];
      /** Closed: answered by you, or its run stopped. */
      resolved?: boolean;
      /** ion's question about a tool call it stopped; expired: ion said no after waiting, the agent went on. */
      blocked?: boolean;
      expired?: boolean;
      answered?: string;
    }
  | { kind: "end"; status: string; seconds: number; cost?: number; reason?: string }
  /** gone: its run ended (done, or failed with it as the reason), so it's not shown on its own. */
  | { kind: "error"; text: string; runId: string; gone?: boolean };

/** The items, plus what the reducer remembers to place later events. */
export type Timeline = {
  items: Item[];
  /** The agent message still streaming, by index. */
  streaming: number | null;
  /** The run that's queued or going, if any. */
  running: string | null;
  /** The agent the chat last ran on: the next message's default. */
  harness: string | null;
  /** Grows with every file change and finished run: the changes panel reads again when it moves. */
  changes: number;
  asks: Record<string, string>;
  work: Record<string, number>;
  tools: Record<string, { at: number; step: number }>;
  questions: Record<string, number>;
  /** ion's questions about stopped calls, by the call's request id. */
  blockedAsks: Record<string, number>;
  started: Record<string, string>;
  cost: Record<string, number>;
};

export const empty = (): Timeline => ({
  items: [],
  streaming: null,
  running: null,
  harness: null,
  changes: 0,
  asks: {},
  work: {},
  tools: {},
  questions: {},
  blockedAsks: {},
  started: {},
  cost: {},
});

type D = Record<string, unknown>;
const str = (x: unknown) => (typeof x === "string" ? x : "");
const push = (t: Timeline, item: Item): Timeline => ({ ...t, items: [...t.items, item], streaming: null });
const replace = (t: Timeline, i: number, item: Item): Timeline => {
  const items = t.items.slice();
  items[i] = item;
  return { ...t, items };
};
const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

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
  };
  const added = push(t, item);
  const at = added.items.length - 1;
  const blockedAsks = d.blocked === true ? { ...t.blockedAsks, [str(d.requestId)]: at } : t.blockedAsks;
  return { ...added, questions: { ...t.questions, [str(d.needId)]: at }, blockedAsks };
}

function answered(t: Timeline, d: D): Timeline {
  const i = t.questions[str(d.needId)];
  const q = i !== undefined ? t.items[i] : undefined;
  if (q?.kind !== "question") return t;
  // Any answer closes it: yours (with the choice), or its run stopping ("superseded").
  const done = d.decision === "answered" ? { resolved: true, answered: str(d.choice) } : { resolved: true };
  return { ...replace(t, i!, { ...q, ...done }), streaming: t.streaming };
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
  [EV.messageSent]: (t, d) => push(t, { kind: "you", text: str(d.text) }),
  [EV.messageDelta]: delta,
  [EV.messageCompleted]: completed,
  [EV.runQueued]: (t, _d, e) => ({ ...t, running: e.runId }),
  [EV.runStarted]: (t, d, e) => ({
    ...retried(t),
    running: e.runId,
    harness: str(d.harness) || t.harness,
    started: { ...t.started, [e.runId ?? ""]: e.ts },
  }),
  [EV.toolStarted]: toolStarted,
  [EV.thinkingDelta]: thinking,
  [EV.toolFinished]: toolFinished,
  [EV.toolOutput]: toolOutput,
  [EV.fileChanged]: (t) => ({ ...t, changes: t.changes + 1 }),
  [EV.approvalRequested]: (t, d) => ({ ...t, asks: { ...t.asks, [str(d.requestId)]: str(d.summary) } }),
  [EV.approvalResolved]: approval,
  [EV.needRaised]: question,
  [EV.needResolved]: answered,
  [EV.decisionRecorded]: (t, d) =>
    d.by === "ion"
      ? push(t, {
          kind: "ion",
          tone: "answer",
          text: `Answered by ion from your decision on ${day(str(d.fromDecidedAt))}: ${str(d.choice)}`,
        })
      : t,
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
};

/** Adds one event to the chat's timeline. Pure: the same events always give the same items. */
export function reduce(t: Timeline, e: IonEvent): Timeline {
  const h = HANDLERS[e.type];
  return h ? h(t, e.data as D, e) : t;
}
