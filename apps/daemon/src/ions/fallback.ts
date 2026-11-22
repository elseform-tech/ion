import { getHarness } from "../adapters/registry.js";
import type { IonBrain } from "./brain.js";

export const NO_AGENT = "I couldn't reach my agent; try again.";
/** NO_AGENT with the agent's own reason, when it gave one. */
const NO_AGENT_WHY = "I couldn't reach my agent: ";
/** The turn found no agent, or its agents failed (with or without their reason). */
export const noAgent = (reply: string): boolean => reply === NO_AGENT || reply.startsWith(NO_AGENT_WHY);
export const TOO_LONG = "I couldn't finish that in time.";
/** What an ion says when you stopped its turn (Esc twice). */
export const STOPPED = "Stopped.";
/** Replies that end a turn without the agent's own words. */
const ENDS: ReadonlySet<string> = new Set([NO_AGENT, TOO_LONG, STOPPED]);

/** A turn's reply and what came with it; `failed` when its agent said nothing (why: its own words, when it said). */
export type Tried<R extends { reply: string }> = R & { failed?: { why: string | null } };
type Failed = { harness: string; why: string | null };

/** Why a turn's agents failed: the first reason one gave, else NO_AGENT. */
function couldNot(failed: Failed[]): string {
  const why = failed.find((f) => f.why)?.why;
  return why ? `${NO_AGENT_WHY}${why}` : NO_AGENT;
}

const labelOf = (id: string) => getHarness(id)?.label ?? id;

/** The reply, with one quiet line: which agent answered, and which didn't. */
const onOther = (reply: string, harness: string, failed: Failed[]) =>
  `${reply}\n\n*On ${labelOf(harness)}: ${failed.map((f) => labelOf(f.harness)).join(", ")} didn't answer.*`;

/** A reply from this agent, with that line when others failed before it. */
function answered<R extends { reply: string }>(r: R, harness: string, failed: Failed[]): R {
  return failed.length && !ENDS.has(r.reply) ? { ...r, reply: onOther(r.reply, harness, failed) } : r;
}

/** An error as one short line for ion's log. */
export const errLine = (e: unknown): string =>
  (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).replace(/\s+/g, " ").slice(0, 300);

/**
 * A turn on its agent; one that failed goes on to the next ready agent (`next`: the order ion picks in) unless `stay`
 * (it started threads, ion is stopping, a dream), and its reply says so in one line (Plan 19's checks, 2026-11-22: a
 * project's ion failed on its agent and said only "I couldn't reach my agent").
 */
export async function onReadyAgents<R extends { reply: string }>(
  first: IonBrain,
  o: {
    once: (b: IonBrain) => Promise<Tried<R>>;
    next: (not: string[]) => Promise<IonBrain | null>;
    stay: (r: R) => boolean;
  },
): Promise<R> {
  const failed: Failed[] = [];
  let brain = first;
  for (;;) {
    const { failed: f, ...rest } = await o.once(brain);
    const r = rest as unknown as R;
    if (!f) return answered(r, brain.harness, failed);
    failed.push({ harness: brain.harness, why: f.why });
    const next = o.stay(r) ? null : await o.next(failed.map((x) => x.harness)).catch(() => null);
    if (!next) return { ...r, reply: couldNot(failed) };
    brain = next;
  }
}
