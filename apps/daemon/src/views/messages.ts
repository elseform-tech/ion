import { EV, type IonEvent } from "@ion/schema";
import type { Db, View } from "../store/index.js";

const ROLE: Partial<Record<string, "you" | "agent">> = {
  [EV.messageSent]: "you",
  [EV.messageCompleted]: "agent",
};

export type HistoryMessage = { role: "you" | "agent"; text: string };
export type SearchHit = { chatId: string; role: "you" | "agent"; text: string; ts: string };

/** Your messages (`message.sent`) and the agent's (`message.completed`), per chat, with full-text search. */
export const messagesView: View & {
  history(db: Db, chatId: string, maxChars: number): HistoryMessage[];
  search(db: Db, projectId: string, query: string, limit: number): SearchHit[];
} = {
  name: "messages",
  version: 1,
  tables: ["view_messages", "messages_fts"],
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS view_messages (
      id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, project_id TEXT, role TEXT NOT NULL, text TEXT NOT NULL, ts TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS view_messages_chat ON view_messages (chat_id, id);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 (text, content='view_messages', content_rowid='id');`);
  },
  reset(db) {
    db.exec("DELETE FROM view_messages; INSERT INTO messages_fts (messages_fts) VALUES ('delete-all');");
  },
  apply(db, e: IonEvent) {
    const role = ROLE[e.type];
    if (!role || !e.chatId) return;
    const text = String((e.data as { text: unknown }).text ?? "");
    const r = db
      .prepare(
        `INSERT INTO view_messages (chat_id, project_id, role, text, ts)
         VALUES (?, (SELECT project_id FROM view_chats WHERE chat_id = ?), ?, ?, ?)`,
      )
      .run(e.chatId, e.chatId, role, text, e.ts);
    db.prepare("INSERT INTO messages_fts (rowid, text) VALUES (?, ?)").run(r.lastInsertRowid, text);
  },
  history(db, chatId, maxChars) {
    const rows = db
      .prepare("SELECT role, text FROM view_messages WHERE chat_id = ? ORDER BY id DESC")
      .all(chatId) as HistoryMessage[];
    const kept: HistoryMessage[] = [];
    let used = 0;
    for (const m of rows) {
      used += m.text.length;
      if (used > maxChars) break;
      kept.unshift(m);
    }
    return kept;
  },
  search(db, projectId, query, limit) {
    // Each word is quoted, so the query is plain words, never FTS syntax.
    const words = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!words.length) return [];
    const match = words.map((w) => `"${w}"`).join(" ");
    return db
      .prepare(
        `SELECT m.chat_id AS chatId, m.role, m.text, m.ts FROM messages_fts f JOIN view_messages m ON m.id = f.rowid
         WHERE messages_fts MATCH ? AND m.project_id = ? ORDER BY m.id DESC LIMIT ?`,
      )
      .all(match, projectId, limit) as SearchHit[];
  },
};
