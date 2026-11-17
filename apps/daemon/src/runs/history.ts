import { wrapData } from "../context/index.js";
import type { HistoryMessage } from "../views/messages.js";

/** How much of a chat's history a new session gets: the newest whole messages up to this many characters. */
export const HISTORY_CHARS = 24_000;

/** The chat's earlier messages as a data block, to start a new session where the old one left off. */
export function historyPreamble(messages: HistoryMessage[]): string {
  // One JSON-encoded message per line: a message's own line breaks can't fake another turn.
  const body = messages.map((m) => `${m.role}: ${JSON.stringify(m.text)}`).join("\n");
  return `${wrapData("this chat's earlier messages", body)}\n\n`;
}

/** Your message, after the chat's history when there is any. */
export function withHistory(messages: HistoryMessage[], text: string): string {
  return messages.length ? historyPreamble(messages) + text : text;
}
