import type { IonEvent } from "@ion/schema";
import type { Item, Timeline } from "./timeline.js";

/*
  A run's work, as the design lab shows it: one umbrella per turn holding its steps in order (thinking, tool
  calls), with when it started and ended ("Worked for 2m 04s").
*/

export type ToolStep = {
  kind: "tool";
  toolKind: string;
  name: string;
  summary: string;
  ok?: boolean;
  input?: string;
  output?: string;
};
type ThinkStep = { kind: "think"; text: string; from: string; to: string };
export type Step = ToolStep | ThinkStep;
export type Work = Extract<Item, { kind: "work" }>;

type D = Record<string, unknown>;
const OUTPUT_MAX = 20 * 1024;
const str = (x: unknown) => (typeof x === "string" ? x : "");

function replace(t: Timeline, i: number, item: Item): Timeline {
  const items = t.items.slice();
  items[i] = item;
  return { ...t, items };
}

/** The run's work item, made the first time it does something (thinking or a tool). */
function workOf(t: Timeline, e: IonEvent): { t: Timeline; at: number; work: Work } {
  const runId = e.runId ?? "";
  const at = t.work[runId];
  const found = at !== undefined ? t.items[at] : undefined;
  if (found?.kind === "work") return { t, at: at!, work: found };
  const work: Work = { kind: "work", runId, started: t.started[runId] ?? e.ts, steps: [] };
  const next = { ...t, items: [...t.items, work], streaming: null };
  const i = next.items.length - 1;
  return { t: { ...next, work: { ...t.work, [runId]: i } }, at: i, work };
}

export function toolStarted(t0: Timeline, d: D, e: IonEvent): Timeline {
  const { t, at, work } = workOf(t0, e);
  const step: ToolStep = {
    kind: "tool",
    toolKind: str(d.kind),
    name: str(d.name),
    summary: str(d.summary),
    ...(d.input ? { input: str(d.input) } : {}),
  };
  const next = replace(t, at, { ...work, steps: [...work.steps, step] });
  return { ...next, tools: { ...t.tools, [str(d.toolId)]: { at, step: work.steps.length } } };
}

/** Thinking streams in pieces; consecutive pieces are one step, timed from the first to the last. */
export function thinking(t0: Timeline, d: D, e: IonEvent): Timeline {
  const { t, at, work } = workOf(t0, e);
  const last = work.steps.at(-1);
  const steps =
    last?.kind === "think"
      ? [...work.steps.slice(0, -1), { ...last, text: last.text + str(d.text), to: e.ts }]
      : [...work.steps, { kind: "think" as const, text: str(d.text), from: e.ts, to: e.ts }];
  return { ...replace(t, at, { ...work, steps }), streaming: t0.streaming };
}

/** Changes one tool step in its run's work item. */
function updateTool(t: Timeline, toolId: string, f: (x: ToolStep) => ToolStep): Timeline {
  const where = t.tools[toolId];
  const work = where ? t.items[where.at] : undefined;
  if (!where || work?.kind !== "work") return t;
  const steps = work.steps.map((x, j) => (j === where.step && x.kind === "tool" ? f(x) : x));
  return { ...replace(t, where.at, { ...work, steps }), streaming: t.streaming };
}

export const toolFinished = (t: Timeline, d: D): Timeline =>
  updateTool(t, str(d.toolId), (x) => ({
    ...x,
    ok: d.ok === true,
    // What the step did, when the harness only knew it at the end (opencode's command; tour, 2026-11-21).
    ...(str(d.summary) ? { summary: str(d.summary) } : {}),
    ...(d.input ? { input: str(d.input) } : {}),
  }));

/** Output arrives in pieces; the chat keeps the first 20 KB. */
export const toolOutput = (t: Timeline, d: D): Timeline =>
  updateTool(t, str(d.toolId), (x) => ({
    ...x,
    output: ((x.output ?? "") + str(d.text)).slice(0, OUTPUT_MAX),
  }));

/** The run ended: its work stops counting time. */
export function workEnded(t: Timeline, e: IonEvent): Timeline {
  const at = t.work[e.runId ?? ""];
  const work = at !== undefined ? t.items[at] : undefined;
  return work?.kind === "work" ? replace(t, at!, { ...work, ended: e.ts }) : t;
}

/** How long the work ran (to now while it's live), in whole seconds. */
export function workSeconds(w: Work, now = Date.now()): number {
  const end = w.ended ? Date.parse(w.ended) : now;
  return Math.max(0, Math.round((end - Date.parse(w.started)) / 1000));
}
