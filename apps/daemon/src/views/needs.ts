import { EV, type IonEvent, type NeedInfo } from "@ion/schema";
import type { Db, View } from "../store/index.js";

type D = Record<string, unknown>;

/** Open "Needs you" items. Applied after the chats view, so a need can carry its chat's project. */
export const needsView: View & {
  open(db: Db, chatId?: string): NeedInfo[];
  find(db: Db, needId: string): { open: boolean; runId: string } | null;
  openByKey(db: Db, chatId: string, dedupeKey: string): string | null;
  openForRun(db: Db, runId: string): string[];
} = {
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
  find(db, needId) {
    const r = db.prepare("SELECT open, run_id AS runId FROM view_needs WHERE need_id = ?").get(needId) as
      | { open: number; runId: string }
      | undefined;
    return r ? { open: r.open === 1, runId: r.runId } : null;
  },
  openByKey(db, chatId, dedupeKey) {
    const r = db
      .prepare("SELECT need_id AS id FROM view_needs WHERE open = 1 AND chat_id = ? AND dedupe_key = ?")
      .get(chatId, dedupeKey) as { id: string } | undefined;
    return r?.id ?? null;
  },
  openForRun(db, runId) {
    return (
      db.prepare("SELECT need_id AS id FROM view_needs WHERE open = 1 AND run_id = ?").all(runId) as {
        id: string;
      }[]
    ).map((r) => r.id);
  },
  open(db, chatId) {
    const sql = `SELECT need_id AS needId, chat_id AS chatId, run_id AS runId, project_id AS projectId, kind, summary,
                 raised_at AS raisedAt FROM view_needs WHERE open = 1 ${chatId ? "AND chat_id = ?" : ""} ORDER BY rowid`;
    return db.prepare(sql).all(...(chatId ? [chatId] : [])) as NeedInfo[];
  },
};
