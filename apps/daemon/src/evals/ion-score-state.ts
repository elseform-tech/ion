import { EV, type IonEvent } from "@ion/schema";
import type { ChatState, IonCase } from "./ion-cases.js";

/**
 * Scoring for the ion evals' status and follow-up cases (Plan 23 Task 3, 2026-11-28), by rules, from the events. A
 * status answer has to name each seeded chat (by a word of its title) with its true state; a hedge that names none
 * fails (Review Focus 1). A follow-up is the project's ion's own lines after its thread ended: the state, once, with
 * what to do.
 */

/** Words that say a chat is in this state. */
const SAYS: Record<ChatState, RegExp> = {
  running:
    /\b(running|in progress|still (going|working|at it)|underway|working on it|(is|are) (still )?\w+ing)\b/i,
  question: new RegExp(
    [
      "question|decide|decision|whether to|on you",
      "waiting (on|for) (you|your)|needs? (you|your)",
      "your (answer|call|decision|input|ok)",
      "ask(s|ing)? (you|whether)",
    ].join("|"),
    "i",
  ),
  failed: /fail|crash|error|didn'?t finish|did not finish|broke/i,
  // With the fake agent a done chat only says hello: "it never happened" is the true state too.
  done: /\bdone\b|finished|complete(d)?\b|succeeded|ended|repl(ied|y)|came back|never (actually )?happened/i,
  limited: /limit|until \d|resets?|quota|paused|on hold|waiting (for|until)/i,
};

/** Words that put a chat in a state it isn't in (only the plain contradictions). */
const WRONG: Record<ChatState, RegExp | null> = {
  running: /\b(has|is) (finished|completed|done)\b|\bfailed\b/i,
  question: null,
  failed: /\b(succeeded|went (fine|well)|completed successfully|finished successfully)\b/i,
  done: /\bfailed\b|\bstill running\b|\bin progress\b/i,
  limited: /\b(has|is) (finished|completed|done)\b/i,
};

/** What to do: a next step offered or asked for. */
const NEXT = new RegExp(
  [
    "try (it |that )?again|retry|re-?run|restart|drop it",
    "answer|reply|decide|choose|pick",
    "want me to|shall i|should i|let me know",
    "look into|check|fix|switch|wait",
  ].join("|"),
  "i",
);

/** A reply's clauses: sentences, lines, and parts joined by ";" or ", and/but/while". */
const clausesOf = (reply: string) =>
  reply
    .split(/(?<=[.!?])\s+|\n+|;\s*|,\s+(?:and|but|while)\s+/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Why a status answer falls short ("" when it doesn't): an item not named, named without or with the wrong state. */
export function statusWhy(c: IonCase, reply: string): string {
  const x = c.expect.status;
  if (!x) return "";
  const clauses = clausesOf(reply);
  for (const { key, state } of x.items) {
    const at = clauses.findIndex((k) => key.test(k));
    if (at < 0) return `doesn't name ${key}`;
    const near = `${clauses[at]} ${clauses[at + 1] ?? ""}`;
    if (WRONG[state]?.test(clauses[at]!)) return `wrong state for ${key} (${state})`;
    if (!SAYS[state].test(near)) return `names ${key} without its state (${state})`;
  }
  if (x.none && !/nothing|not waiting|all clear|\bnone\b|no (open )?questions?/i.test(reply))
    return "doesn't say nothing needs you";
  return "";
}

const dataOf = (e: IonEvent) => e.data as Record<string, unknown>;

/** Where the ion's own thread ended (its first run.finished), or -1 while it hasn't. */
function endOf(events: IonEvent[]): { at: number; chatId: string | null } {
  const created = events.find((e) => e.type === EV.chatCreated && dataOf(e).by === "ion");
  const chatId = created?.chatId ?? null;
  return {
    at: chatId ? events.findIndex((e) => e.type === EV.runFinished && e.chatId === chatId) : -1,
    chatId,
  };
}

/** The project's ion's own lines after its thread ended (not its cards). */
function linesAfter(events: IonEvent[], ionId: string): string[] {
  const { at } = endOf(events);
  if (at < 0) return [];
  return events
    .slice(at + 1)
    .filter((e) => e.type === EV.ionSaid && e.chatId === `ion:${ionId}` && !dataOf(e).card)
    .map((e) => String(dataOf(e).text ?? ""));
}

/** A follow-up case's reply: the ion's first line after its thread ended ("" when it said nothing). */
export const followUpReply = (events: IonEvent[], ionId: string): string =>
  linesAfter(events, ionId)[0] ?? "";

/** ion's own questions about the thread's limit (wait, or go on another agent). */
const limitAsks = (events: IonEvent[], chatId: string | null) =>
  events.filter((e) => e.type === EV.needRaised && e.chatId === chatId && dataOf(e).limit).length;

/**
 * Why a follow-up falls short ("" when it doesn't): the thread's end never brought up, brought up more than once, or
 * (failed, a question) without what to do; a done thread called failed.
 */
export function followUpWhy(c: IonCase, events: IonEvent[]): string {
  const state = c.expect.followUp?.state;
  if (!state) return "";
  const { at, chatId } = endOf(events);
  if (at < 0) return "the thread never ended";
  const lines = linesAfter(events, c.to).filter((l) => SAYS[state].test(l));
  const told = lines.length + (state === "limited" ? limitAsks(events, chatId) : 0);
  if (!told) return `dropped: nothing said of it being ${state}`;
  if (told > 1) return `repeated: brought up ${told} times`;
  if (state === "done") return WRONG.done!.test(lines[0] ?? "") ? "called a done thread failed" : "";
  if ((state === "failed" || state === "question") && !NEXT.test(lines[0]!))
    return "says nothing about what to do";
  return "";
}
