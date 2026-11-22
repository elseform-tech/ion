import { getHarness } from "../adapters/registry.js";
import { clockOf } from "@ion/schema";
import { looksLikeToken } from "../tools/shown.js";
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

/**
 * A turn's reply and what came with it; `failed` when its agent said nothing (why: its own words, when it said;
 * `did`: it wrote memory or started a thread first, so it isn't tried again).
 */
export type Tried<R extends { reply: string }> = R & { failed?: { why: string | null; did: boolean } };
type Failed = { harness: string; why: string | null };

/** Why a turn's agents failed: the first reason one gave, else NO_AGENT. */
function couldNot(failed: Failed[]): string {
  const why = failed.find((f) => f.why)?.why;
  return why ? `${NO_AGENT_WHY}${why}` : NO_AGENT;
}

const labelOf = (id: string) => getHarness(id)?.label ?? id;

/** Until when an agent is limited (ISO), or null; and the clock its reset is told by. */
type Limits = { limitedUntil?: (harness: string) => string | null; now?: () => Date };

/** Why an agent was passed over, in a few words: "Claude Code is limited until 16:00", or that it didn't answer. */
function whyNot(harnesses: string[], l: Limits): string {
  const until = (h: string) => l.limitedUntil?.(h) ?? null;
  const limited = harnesses
    .filter(until)
    .map((h) => `${labelOf(h)} is limited until ${clockOf(until(h)!, (l.now ?? (() => new Date()))())}`);
  const quiet = harnesses.filter((h) => !until(h)).map(labelOf);
  return [...limited, ...(quiet.length ? [`${quiet.join(", ")} didn't answer`] : [])].join("; ");
}

/**
 * The reply, with one quiet line: which agent answered, and which didn't or were limited (the user, 2026-11-22: "On
 * Grok Build — Claude Code is limited until 16:00").
 */
function onOther(reply: string, harness: string, passed: string[], l: Limits): string {
  const sep = passed.some((h) => l.limitedUntil?.(h)) ? " —" : ":";
  return `${reply}\n\n*On ${labelOf(harness)}${sep} ${whyNot(passed, l)}.*`;
}

/** A reply from this agent, with that line when others failed or were passed over before it. */
function answered<R extends { reply: string }>(r: R, harness: string, passed: string[], l: Limits): R {
  return passed.length && !ENDS.has(r.reply) ? { ...r, reply: onOther(r.reply, harness, passed, l) } : r;
}

const HIDDEN = "•••";
const LINK = /\b[a-z][\w+.-]*:\/\/\S+/gi;
const BEARER = /\b(bearer|basic)\s+\S+/gi;
const NAMED = /\b(\w*(?:key|token|secret|password|auth)\w*)\s*[=:]\s*[^\s,;)]+/gi;
const PREFIXED = /\b(?:sk|pk|rk|ghp|gho|ghs|xox[abprs])[-_][\w-]{6,}/gi;
const WORD = /[\w.+/=-]{20,}/g;

/**
 * An agent's reason as ion shows and logs it: one line of at most 200 characters, with links, keys and anything
 * key-like hidden (security review, 2026-11-22).
 */
export function cleanWhy(why: string): string {
  return why
    .replace(LINK, "(a link)")
    .replace(BEARER, `$1 ${HIDDEN}`)
    .replace(NAMED, `$1=${HIDDEN}`)
    .replace(PREFIXED, HIDDEN)
    .replace(WORD, (w) => (looksLikeToken(w) ? HIDDEN : w))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** An error as one clean line for ion's log. */
export const errLine = (e: unknown): string =>
  cleanWhy(e instanceof Error ? `${e.name}: ${e.message}` : String(e));

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
  } & Limits,
): Promise<R> {
  const failed: Failed[] = [];
  let brain = first;
  for (;;) {
    const { failed: f, ...rest } = await o.once(brain);
    const r = rest as unknown as R;
    const passed = [...(first.skipped ?? []), ...failed.map((x) => x.harness)];
    if (!f) return answered(r, brain.harness, passed, o);
    failed.push({ harness: brain.harness, why: f.why });
    const next = f.did || o.stay(r) ? null : await o.next(failed.map((x) => x.harness)).catch(() => null);
    if (!next) return { ...r, reply: couldNot(failed) };
    brain = next;
  }
}
