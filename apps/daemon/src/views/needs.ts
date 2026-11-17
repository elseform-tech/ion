import { EV, type IonEvent, type NeedInfo } from "@ion/schema";
import type { Db, View } from "../store/index.js";

type D = Record<string, unknown>;

/** Open "Needs you" items. Applied after the chats view, so a need can carry its chat's project. */
export const needsView: View & { open(db: Db, chatId?: string): NeedInfo[] } = {
  name: "needs",
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS view_needs (
      need_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, run_id TEXT NOT NULL, project_id TEXT,
      kind TEXT NOT NULL, summary TEXT NOT NULL, dedupe_key TEXT NOT NULL, open INTEGER NOT NULL, raised_at TEXT NOT NULL)`);
  },
  reset(db) {
    db.exec("DELETE FROM view_needs");
  },
  apply(db, e: IonEvent) {
    const d = e.data as D;
    if (e.type === EV.needRaised && e.chatId && e.runId) {
      db.prepare(
        `INSERT OR IGNORE INTO view_needs (need_id, chat_id, run_id, project_id, kind, summary, dedupe_key, open, raised_at)
         VALUES (?, ?, ?, (SELECT project_id FROM view_chats WHERE chat_id = ?), ?, ?, ?, 1, ?)`,
      ).run(
        String(d.needId),
        e.chatId,
        e.runId,
        e.chatId,
        String(d.kind),
        String(d.summary),
        String(d.dedupeKey),
        e.ts,
      );
    } else if (e.type === EV.needResolved) {
      db.prepare("UPDATE view_needs SET open = 0 WHERE need_id = ?").run(String(d.needId));
    }
  },
  open(db, chatId) {
    const sql = `SELECT need_id AS needId, chat_id AS chatId, run_id AS runId, project_id AS projectId, kind, summary,
                 raised_at AS raisedAt FROM view_needs WHERE open = 1 ${chatId ? "AND chat_id = ?" : ""} ORDER BY rowid`;
    return db.prepare(sql).all(...(chatId ? [chatId] : [])) as NeedInfo[];
  },
};
