import { EV, type IonEvent } from "@ion/schema";
import type { ChatState, IonCase } from "./ion-cases.js";

/**
 * Scoring for the ion evals' status and follow-up cases (Plan 23 Task 3, 2026-11-28), by rules, from the events. A
 * status answer has to name each seeded chat (by a word of its title) with its true state; a hedge that names none
 * fails (Review Focus 1). A follow-up is the project's ion's own lines after its thread ended: the state, once, with
 * what to do.
 */

/** Words that say a chat is in this state: whole words and plain phrases only (final review I3, 2026-11-28). */
const SAYS: Record<ChatState, RegExp> = {
  running:
    /\b(running|in progress|underway|still (going|working|at it)|working on it|mid-work|(is|are) (still )?(rebuilding|building|upgrading|working))\b/i,
  question: new RegExp(
    [
      "\\bquestion\\b|\\bdecide\\b|\\bwhether to\\b|\\bon you\\b",
      "\\bwaiting (on|for) (you|your|one decision|a decision)\\b|\\bneeds? (you|your)\\b",
      "\\byour (answer|call|decision|input|ok)\\b|\\bask(s|ing)? (you|whether)\\b",
    ].join("|"),
    "i",
  ),
  failed: /\b(failed|fails|crashed|didn'?t finish|did not finish|broke)\b/i,
  // With the fake agent a done chat only says hello: "it never happened" is the true state too.
  done: /\b(done|finished|completed?)\b|\bnever (actually )?happened\b/i,
  limited: /\b(limit|limited|usage limit|until \d|quota|on hold|paused|waiting out)\b/i,
};

/** States one clause may give a chat together and both be true (a chat that ended and left a question; a limit's failure). */
const BOTH: Record<ChatState, ChatState[]> = {
  running: [],
  question: ["done"],
  failed: ["limited"],
  done: ["question"],
  limited: ["failed"],
};

/** A hedge: the state is a guess, not a report (Review Focus 1). */
const HEDGE = /\b(may|might|could|possibly|perhaps|probably|not sure|unclear)\b/i;

/** Why one item's clause falls short: a hedge, another state's words, or its own state missing. */
function itemWhy(clause: string, near: string, item: { key: RegExp; state: ChatState }): string {
  const { key, state } = item;
  if (HEDGE.test(clause)) return `hedges on ${key} (${state})`;
  const others = (Object.keys(SAYS) as ChatState[]).filter((s) => s !== state && !BOTH[state].includes(s));
  const wrong = others.find((s) => SAYS[s].test(clause) && !SAYS[state].test(clause));
  if (wrong) return `wrong state for ${key}: ${wrong}, not ${state}`;
  return SAYS[state].test(near) ? "" : `names ${key} without its state (${state})`;
}

/** What to do next: an offer or a step for the user, as whole words (final review I4). */
const NEXT = new RegExp(
  [
    "\\btry (it |that )?again\\b|\\bretry\\b|\\bre-?run\\b|\\brestart\\b|\\bdrop it\\b",
    "\\bwant me to\\b|\\bshall i\\b|\\bshould i\\b|\\blet me know\\b|\\btell me\\b",
    "\\byou (can|could|may want to)\\b|\\blook into\\b|\\bcheck (what|why|the log)\\b",
    "\\b(answer|reply) (it|with|yes|no)\\b|\\bdecide\\b|\\bchoose\\b|\\bwhether\\b",
  ].join("|"),
  "i",
);

/** Where a sentence ends (after a closing quote too), a line, ";", or ", and/but/while". */
const SENTENCE = /(?<=[.!?]["”’']?)\s+/;
const JOINS = /\n+|;\s*|,\s+(?:and|but|while)\s+/;

/** A reply's clauses: sentences, lines, and parts joined by ";" or ", and/but/while". */
const clausesOf = (reply: string) =>
  reply
    .split(SENTENCE)
    .flatMap((x) => x.split(JOINS))
    .map((x) => x.trim())
    .filter(Boolean);

/** Why a status answer falls short ("" when it doesn't): an item not named, named without or with the wrong state. */
export function statusWhy(c: IonCase, reply: string): string {
  const x = c.expect.status;
  if (!x) return "";
  const clauses = clausesOf(reply);
  for (const item of x.items) {
    const at = clauses.findIndex((k) => item.key.test(k));
    if (at < 0) return `doesn't name ${item.key}`;
    const why = itemWhy(clauses[at]!, `${clauses[at]} ${clauses[at + 1] ?? ""}`, item);
    if (why) return why;
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
  if (state === "done") return SAYS.failed.test(lines[0] ?? "") ? "called a done thread failed" : "";
  return state === "failed" || state === "question"
    ? nextWhy(state, withoutTitle(lines[0]!, titleOf(events)))
    : "";
}

/** Whether a failure's or a question's line says what to do; a question's may put the decision itself to the user. */
function nextWhy(state: ChatState, line: string): string {
  const decided = state === "question" && (/\?/.test(line) || /\byes or no\b/i.test(line));
  return decided || NEXT.test(line) ? "" : "says nothing about what to do";
}

/** The title of the thread the ion started ("" when none). */
const titleOf = (events: IonEvent[]) =>
  String(
    dataOf(
      events.find((e) => e.type === EV.chatCreated && dataOf(e).by === "ion") ?? ({ data: {} } as IonEvent),
    ).title ?? "",
  );

/** A line without the thread's title in it (its words never count as what to do: "Fix the cart drawer"). */
function withoutTitle(line: string, title: string): string {
  const words = title.trim().split(/\s+/).slice(1).join(" ");
  if (!words) return line;
  const escaped = words.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return line.replace(new RegExp(escaped, "gi"), "");
}
