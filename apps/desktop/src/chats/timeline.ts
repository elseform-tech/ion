import { EV, type IonEvent } from "@ion/schema";

export type Choice = { label: string; consequence: string };
export type Tool = { name: string; summary: string; ok?: boolean };

/** One thing the chat shows, in order. */
export type Item =
  | { kind: "you"; text: string }
  | { kind: "agent"; text: string; done: boolean }
  | { kind: "work"; runId: string; tools: Tool[] }
  | { kind: "ion"; tone: "allow" | "deny" | "answer" | "note"; text: string }
  | {
      kind: "question";
      needId: string;
      question: string;
      why: string | null;
      choices: Choice[];
      answered?: string;
    }
  | { kind: "end"; status: string; seconds: number; cost?: number }
  | { kind: "error"; text: string };

/** The items, plus what the reducer remembers to place later events. */
export type Timeline = {
  items: Item[];
  /** The agent message still streaming, by index. */
  streaming: number | null;
  asks: Record<string, string>;
  work: Record<string, number>;
  tools: Record<string, { at: number; tool: number }>;
  questions: Record<string, number>;
  started: Record<string, string>;
  cost: Record<string, number>;
};

export const empty = (): Timeline => ({
  items: [],
  streaming: null,
  asks: {},
  work: {},
  tools: {},
  questions: {},
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

function toolStarted(t: Timeline, d: D, runId: string): Timeline {
  const tool: Tool = { name: str(d.name), summary: str(d.summary) };
  const at = t.work[runId];
  const work = at !== undefined ? t.items[at] : undefined;
  if (work?.kind === "work") {
    const next = replace(t, at!, { ...work, tools: [...work.tools, tool] });
    return { ...next, tools: { ...t.tools, [str(d.toolId)]: { at: at!, tool: work.tools.length } } };
  }
  const added = push(t, { kind: "work", runId, tools: [tool] });
  const i = added.items.length - 1;
  return {
    ...added,
    work: { ...t.work, [runId]: i },
    tools: { ...t.tools, [str(d.toolId)]: { at: i, tool: 0 } },
  };
}

function toolFinished(t: Timeline, d: D): Timeline {
  const where = t.tools[str(d.toolId)];
  const work = where ? t.items[where.at] : undefined;
  if (!where || work?.kind !== "work") return t;
  const tools = work.tools.map((x, j) => (j === where.tool ? { ...x, ok: d.ok === true } : x));
  return { ...replace(t, where.at, { ...work, tools }), streaming: t.streaming };
}

function approval(t: Timeline, d: D): Timeline {
  if (d.by !== "ion") return t;
  const what = str(d.summary) || t.asks[str(d.requestId)] || "a tool";
  if (d.decision === "deny")
    return push(t, { kind: "ion", tone: "deny", text: `Denied by ion: ${what} — ${str(d.reason)}` });
  return push(t, { kind: "ion", tone: "allow", text: `Allowed by ion: ${what}` });
}

function question(t: Timeline, d: D): Timeline {
  if (d.kind !== "ask" || !Array.isArray(d.choices)) return t;
  const item: Item = {
    kind: "question",
    needId: str(d.needId),
    question: str(d.summary),
    why: typeof d.detail === "string" ? d.detail : null,
    choices: d.choices as Choice[],
  };
  const added = push(t, item);
  return { ...added, questions: { ...t.questions, [str(d.needId)]: added.items.length - 1 } };
}

function answered(t: Timeline, d: D): Timeline {
  const i = t.questions[str(d.needId)];
  const q = i !== undefined ? t.items[i] : undefined;
  if (d.decision !== "answered" || q?.kind !== "question") return t;
  return { ...replace(t, i!, { ...q, answered: str(d.choice) }), streaming: t.streaming };
}

function finished(t: Timeline, d: D, e: IonEvent): Timeline {
  const runId = e.runId ?? "";
  const from = t.started[runId];
  const seconds = from ? Math.round((Date.parse(e.ts) - Date.parse(from)) / 1000) : 0;
  const cost = t.cost[runId];
  return push(t, { kind: "end", status: str(d.status), seconds, ...(cost !== undefined ? { cost } : {}) });
}

type Handler = (t: Timeline, d: D, e: IonEvent) => Timeline;

const HANDLERS: Record<string, Handler> = {
  [EV.messageSent]: (t, d) => push(t, { kind: "you", text: str(d.text) }),
  [EV.messageDelta]: delta,
  [EV.messageCompleted]: completed,
  [EV.runStarted]: (t, _d, e) => ({ ...t, started: { ...t.started, [e.runId ?? ""]: e.ts } }),
  [EV.toolStarted]: (t, d, e) => toolStarted(t, d, e.runId ?? ""),
  [EV.toolFinished]: toolFinished,
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
  [EV.runRetrying]: (t, d) =>
    push(t, {
      kind: "ion",
      tone: "note",
      text: `Retrying in ${Math.ceil(Number(d.delayS) || 0)}s (${str(d.reason).toLowerCase()})`,
    }),
  [EV.runFinished]: finished,
  [EV.error]: (t, d) => push(t, { kind: "error", text: str(d.message) }),
};

/** Adds one event to the chat's timeline. Pure: the same events always give the same items. */
export function reduce(t: Timeline, e: IonEvent): Timeline {
  const h = HANDLERS[e.type];
  return h ? h(t, e.data as D, e) : t;
}
