import { EV, type IonCard, type IonEvent } from "@ion/schema";
import { thinking, toolFinished, toolStarted, type Work, workEnded } from "../chats/steps.js";
import { empty, type Timeline } from "../chats/timeline.js";

/** One thing an ion's chat shows: your message, a turn's work while it runs, or the ion's line with its card. */
export type IonItem =
  | { kind: "you"; text: string }
  /** A turn's thinking and tool calls (Plan 14) while it runs; once it replies, they go above its reply. */
  | { kind: "work"; work: Work }
  /**
   * `answered`: your answer to its suggestion card (keep or not), once you've given it; `muted`: no more like it;
   * `work`: what its turn did, when this is a turn's reply.
   */
  | { kind: "ion"; text: string; card?: IonCard; answered?: boolean; muted?: true; work?: Work };

type Answer = { keep: boolean; mute?: true };
type D = Record<string, unknown>;
const suggestionIdOf = (c: IonCard | undefined) => (c && "suggestionId" in c ? c.suggestionId : undefined);

/** A turn's session events (kept with the turn's id as their run), as a plain chat's work steps. */
const STEPS: Record<string, (t: Timeline, d: D, e: IonEvent) => Timeline> = {
  [EV.toolStarted]: toolStarted,
  [EV.thinkingDelta]: thinking,
  [EV.toolFinished]: (t, d) => toolFinished(t, d),
};

/** In order: your messages, a turn's work (by its id, where it started), the ion's lines (a reply: its turn's id). */
type Raw = { kind: "you"; text: string } | { kind: "work"; runId: string } | { kind: "said"; e: IonEvent };

/** What the reducer remembers: the lines so far, the turns' work, and when you last spoke (a turn's start). */
type Acc = { raw: Raw[]; t: Timeline; heard: string | null };

/** A tool call or thinking on a turn: its work counts from your message (else from its first step). */
function step(acc: Acc, e: IonEvent, reduce: (t: Timeline, d: D, e: IonEvent) => Timeline): Acc {
  const runId = e.runId ?? "";
  const fresh = acc.t.work[runId] === undefined;
  const started = fresh ? { ...acc.t.started, [runId]: acc.heard ?? e.ts } : acc.t.started;
  const raw: Raw[] = fresh ? [...acc.raw, { kind: "work", runId }] : acc.raw;
  return { ...acc, raw, t: reduce({ ...acc.t, started }, e.data as D, e) };
}

/** The ion's line; a turn's reply (it carries the turn's id) ends that turn's work, and no other line ends any. */
function said(acc: Acc, e: IonEvent): Acc {
  const raw: Raw[] = [...acc.raw, { kind: "said", e }];
  if (!e.runId) return { ...acc, raw };
  const at = acc.t.work[e.runId];
  const w = at !== undefined ? acc.t.items[at] : undefined;
  return { ...acc, raw, t: w?.kind === "work" && !w.ended ? workEnded(acc.t, e) : acc.t, heard: null };
}

/** The ion's line, with your answer to its suggestion card if you gave one, and its turn's work if it's a reply. */
function line(e: IonEvent, answers: Map<string, Answer>, work: Work | undefined): IonItem {
  const d = e.data as { text?: string; card?: IonCard };
  const id = suggestionIdOf(d.card);
  const a = id ? answers.get(id) : undefined;
  return {
    kind: "ion",
    text: d.text ?? "",
    ...(d.card ? { card: d.card } : {}),
    ...(a ? { answered: a.keep } : {}),
    ...(a?.mute ? { muted: true as const } : {}),
    ...(work ? { work } : {}),
  };
}

/** An ion's chat (its events on "ion:<ionId>") as what it shows, in order. Pure. */
export function ionTimeline(events: IonEvent[]): IonItem[] {
  const answers = new Map(
    events
      .filter((e) => e.type === EV.suggestionAnswered)
      .map((e) => [(e.data as { suggestionId: string }).suggestionId, e.data as Answer]),
  );
  let acc: Acc = { raw: [], t: empty(), heard: null };
  for (const e of events) {
    const reduce = e.runId ? STEPS[e.type] : undefined;
    if (e.type === EV.ionHeard)
      acc = {
        ...acc,
        raw: [...acc.raw, { kind: "you", text: String((e.data as D).text ?? "") }],
        heard: e.ts,
      };
    else if (reduce) acc = step(acc, e, reduce);
    else if (e.type === EV.ionSaid) acc = said(acc, e);
  }
  const workOf = (runId: string | null) => {
    const at = runId ? acc.t.work[runId] : undefined;
    const w = at !== undefined ? acc.t.items[at] : undefined;
    return w?.kind === "work" ? w : undefined;
  };
  const replied = new Set(acc.raw.flatMap((r) => (r.kind === "said" && r.e.runId ? [r.e.runId] : [])));
  return acc.raw.flatMap((r): IonItem[] => {
    if (r.kind === "you") return [r];
    if (r.kind === "said") return [line(r.e, answers, workOf(r.e.runId))];
    const w = replied.has(r.runId) ? undefined : workOf(r.runId);
    return w ? [{ kind: "work", work: w }] : [];
  });
}
