import { EV, type IonCard, type IonEvent } from "@ion/schema";
import { thinking, toolFinished, toolStarted, type Work, workEnded } from "../chats/steps.js";
import { empty, type Timeline } from "../chats/timeline.js";

/** One thing an ion's chat shows: your message, a turn's work, or the ion's line with its card if it has one. */
export type IonItem =
  | { kind: "you"; text: string }
  /** A turn's thinking and tool calls (Plan 14), shown above the reply that ends it. */
  | { kind: "work"; work: Work }
  /** `answered`: your answer to its suggestion card (keep or not), once you've given it; `muted`: no more like it. */
  | { kind: "ion"; text: string; card?: IonCard; answered?: boolean; muted?: true };

type Answer = { keep: boolean; mute?: true };
type D = Record<string, unknown>;
const suggestionIdOf = (c: IonCard | undefined) => (c && "suggestionId" in c ? c.suggestionId : undefined);

/** A turn's session events (kept with the turn's id as their run), as a plain chat's work steps. */
const STEPS: Record<string, (t: Timeline, d: D, e: IonEvent) => Timeline> = {
  [EV.toolStarted]: toolStarted,
  [EV.thinkingDelta]: thinking,
  [EV.toolFinished]: (t, d) => toolFinished(t, d),
};

/** What the reducer remembers: the items so far, the turns' work, and when you last spoke (a turn's start). */
type Acc = { items: IonItem[]; t: Timeline; at: Record<string, number>; heard: string | null };

/** Puts each turn's work (as the steps reducer has it) in the chat: in its place, else at the end. */
function placeWork(acc: Acc): Acc {
  const items = acc.items.slice();
  const at = { ...acc.at };
  for (const [runId, i] of Object.entries(acc.t.work)) {
    const work = acc.t.items[i];
    if (work?.kind !== "work") continue;
    const k = at[runId];
    if (k === undefined) at[runId] = items.push({ kind: "work", work }) - 1;
    else items[k] = { kind: "work", work };
  }
  return { ...acc, items, at };
}

/** A tool call or thinking on a turn: its work counts from your message (else from its first step). */
function step(acc: Acc, e: IonEvent): Acc {
  const runId = e.runId ?? "";
  const started = acc.t.started[runId] ? acc.t.started : { ...acc.t.started, [runId]: acc.heard ?? e.ts };
  const reduce = STEPS[e.type];
  return reduce ? placeWork({ ...acc, t: reduce({ ...acc.t, started }, e.data as D, e) }) : acc;
}

/** The ion replied: the turns still working end there (a card the daemon says meanwhile ends none). */
function replied(acc: Acc, e: IonEvent): Acc {
  const card = (e.data as { card?: IonCard }).card;
  if (card && card.kind !== "threads") return acc;
  let t = acc.t;
  for (const [runId, i] of Object.entries(t.work)) {
    const w = t.items[i];
    if (w?.kind === "work" && !w.ended) t = workEnded(t, { ...e, runId });
  }
  return placeWork({ ...acc, t, heard: null });
}

/** The ion's line, with your answer to its suggestion card if you gave one. */
function said(e: IonEvent, answers: Map<string, Answer>): IonItem {
  const d = e.data as { text?: string; card?: IonCard };
  const id = suggestionIdOf(d.card);
  const a = id ? answers.get(id) : undefined;
  return {
    kind: "ion",
    text: d.text ?? "",
    ...(d.card ? { card: d.card } : {}),
    ...(a ? { answered: a.keep } : {}),
    ...(a?.mute ? { muted: true as const } : {}),
  };
}

/** An ion's chat (its events on "ion:<ionId>") as what it shows, in order. Pure. */
export function ionTimeline(events: IonEvent[]): IonItem[] {
  const answers = new Map(
    events
      .filter((e) => e.type === EV.suggestionAnswered)
      .map((e) => [(e.data as { suggestionId: string }).suggestionId, e.data as Answer]),
  );
  let acc: Acc = { items: [], t: empty(), at: {}, heard: null };
  for (const e of events) {
    if (e.type === EV.ionHeard) {
      const you: IonItem = { kind: "you", text: String((e.data as D).text ?? "") };
      acc = { ...acc, items: [...acc.items, you], heard: e.ts };
    } else if (e.runId && e.type in STEPS) acc = step(acc, e);
    else if (e.type === EV.ionSaid) {
      const after = replied(acc, e);
      acc = { ...after, items: [...after.items, said(e, answers)] };
    }
  }
  return acc.items;
}
