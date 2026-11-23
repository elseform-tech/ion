import { wrapData } from "../context/index.js";
import { type HistoryMessage, messagesView } from "../views/messages.js";
import type { Db } from "../store/index.js";
import { type MemoryFiles, upFront } from "../memory/index.js";

export type { MemoryFiles };

/** How much of a long chat's last messages a new session gets after ion's summary, at most, in characters. */
export const HISTORY_CHARS = 24_000;
/** How many of a long chat's last messages a new session gets verbatim after ion's summary. */
const LAST_MESSAGES = 6;
/** An agent's context when its adapter doesn't say. */
const CONTEXT_TOKENS = 128_000;

/**
 * How much history a new session on this agent gets in full (ruling, 2026-11-22): a quarter of its context, at four
 * characters a token until ion knows the tokens, and never more than 100,000 characters. A longer history goes as
 * ion's summary and the last messages.
 */
const historyBudget = (contextTokens?: number) => Math.min(contextTokens ?? CONTEXT_TOKENS, 100_000);

/**
 * What a new run gets of its chat's history (read before your message is stored: what came before): the newest up to
 * the agent's budget, and whether there's more than that (then a new session gets ion's summary).
 */
export function historyOf(
  db: Db,
  chatId: string | null,
  contextTokens: number | undefined,
): { history: HistoryMessage[]; long?: { budget: number } } {
  if (!chatId) return { history: [] };
  const budget = historyBudget(contextTokens);
  const history = messagesView.history(db, chatId, budget);
  return messagesView.size(db, chatId) > budget ? { history, long: { budget } } : { history };
}

/** The chat's earlier messages as a data block, to start a new session where the old one left off. */
export function historyPreamble(messages: HistoryMessage[], maxChars = HISTORY_CHARS): string {
  // One JSON-encoded message per line: a message's own line breaks can't fake another turn. The budget counts these
  // escaped lines, newest first; the newest message always fits (its end is kept when it alone is too long).
  const lines: string[] = [];
  let used = 0;
  for (const m of [...messages].reverse()) {
    let line = `${m.role}: ${JSON.stringify(m.text)}`;
    if (!lines.length && line.length > maxChars) {
      const tail = "…" + m.text.slice(-maxChars / 2);
      line = `${m.role}: ${JSON.stringify(tail)}`;
    }
    if (used + line.length > maxChars) break;
    used += line.length + 1;
    lines.unshift(line);
  }
  const body = lines.join("\n");
  return `${wrapData("this chat's earlier messages", body)}\n\n`;
}

/** Your message, after the chat's history when there is any (`maxChars` of it, the newest). */
export function withHistory(messages: HistoryMessage[], text: string, maxChars = HISTORY_CHARS): string {
  return messages.length ? historyPreamble(messages, maxChars) + text : text;
}

type Fresh = {
  /** The chat's history, the newest up to its agent's budget. */
  history: HistoryMessage[];
  args: { text: string };
  projectId: string;
  chatId: string;
  runId: string;
  /** Its history is longer than the agent's budget: the budget, and ion's summary of the chat (none: a handoff). */
  long?: { budget: number; brief?: string };
};

/**
 * What of the chat a new session gets before your message: a short chat's whole history; a long one's summary (ion's
 * brief) and its last few messages verbatim. A handoff's message is already a brief: just the last messages.
 */
function pastOf(l: Fresh): string {
  if (!l.long) return withHistory(l.history, l.args.text, Number.MAX_SAFE_INTEGER);
  const last = withHistory(l.history.slice(-LAST_MESSAGES), l.args.text);
  return l.long.brief ? `${l.long.brief}\n\n${last}` : last;
}

/**
 * A new session's first message: the chat's memory index (when its run has ion's tools, `mcpKey`, to read more), its
 * history (or ion's summary and its last messages), then your message; `index`: whether the index is there.
 */
export function freshText(
  l: Fresh & { mcpKey?: string },
  memory: MemoryFiles | undefined,
): { text: string; index: boolean } {
  const index = upFront(l.mcpKey ? memory : undefined, { kind: "chat", ...l });
  return { text: index + pastOf(l), index: index !== "" };
}
