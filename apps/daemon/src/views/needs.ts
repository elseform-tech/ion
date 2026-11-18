import { EV, type IonEvent, type NeedInfo } from "@ion/schema";
import type { Db, View } from "../store/index.js";

type D = Record<string, unknown>;

/** Open "Needs you" items. Applied after the chats view, so a need can carry its chat's project. */
export const needsView: View & {
  open(db: Db, chatId?: string): NeedInfo[];
  find(
    db: Db,
    needId: string,
  ): { open: boolean; runId: string; chatId: string; decision: string | null; kind: string } | null;
  openByKey(db: Db, chatId: string, dedupeKey: string): string | null;
  openForRun(db: Db, runId: string): string[];
} = {
  name: "needs",
  version: 3,
  tables: ["view_needs"],
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS view_needs (
      need_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, run_id TEXT NOT NULL, project_id TEXT,
      kind TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT, dedupe_key TEXT NOT NULL, open INTEGER NOT NULL, decision TEXT, raised_at TEXT NOT NULL,
      choices TEXT, blocked INTEGER NOT NULL DEFAULT 0)`);
  },
  reset(db) {
    db.exec("DELETE FROM view_needs");
  },
  apply(db, e: IonEvent) {
    const d = e.data as D;
    if (e.type === EV.needRaised && e.chatId && e.runId) {
      db.prepare(
        `INSERT OR IGNORE INTO view_needs (need_id, chat_id, run_id, project_id, kind, summary, detail, dedupe_key, open, raised_at, choices, blocked)
         VALUES (?, ?, ?, (SELECT project_id FROM view_chats WHERE chat_id = ?), ?, ?, ?, ?, 1, ?, ?, ?)`,
      ).run(
        String(d.needId),
        e.chatId,
        e.runId,
        e.chatId,
        String(d.kind),
        String(d.summary),
        d.detail == null ? null : String(d.detail),
        String(d.dedupeKey),
        e.ts,
        d.choices ? JSON.stringify(d.choices) : null,
        d.blocked === true ? 1 : 0,
      );
    } else if (e.type === EV.needResolved) {
      db.prepare("UPDATE view_needs SET open = 0, decision = ? WHERE need_id = ?").run(
        String(d.decision),
        String(d.needId),
      );
    }
  },
  find(db, needId) {
    const r = db
      .prepare(
        "SELECT open, run_id AS runId, chat_id AS chatId, decision, kind FROM view_needs WHERE need_id = ?",
      )
      .get(needId) as
      | { open: number; runId: string; chatId: string; decision: string | null; kind: string }
      | undefined;
    return r ? { ...r, open: r.open === 1 } : null;
  },
  openByKey(db, chatId, dedupeKey) {
    const r = db
      .prepare("SELECT need_id AS id FROM view_needs WHERE open = 1 AND chat_id = ? AND dedupe_key = ?")
      .get(chatId, dedupeKey) as { id: string } | undefined;
    return r?.id ?? null;
  },
  // An agent's question outlives the run that asked it (the agent ends its turn to wait for you).
  openForRun(db, runId) {
    return (
      db
        .prepare("SELECT need_id AS id FROM view_needs WHERE open = 1 AND run_id = ? AND kind != 'ask'")
        .all(runId) as {
        id: string;
      }[]
    ).map((r) => r.id);
  },
  open(db, chatId) {
    const sql = `SELECT need_id AS needId, chat_id AS chatId, run_id AS runId, project_id AS projectId, kind, summary, detail,
                 raised_at AS raisedAt, choices, blocked FROM view_needs WHERE open = 1 ${chatId ? "AND chat_id = ?" : ""} ORDER BY rowid`;
    const rows = db.prepare(sql).all(...(chatId ? [chatId] : [])) as (Omit<
      NeedInfo,
      "choices" | "blocked"
    > & {
      choices: string | null;
      blocked: number;
    })[];
    return rows.map(({ choices, blocked, ...n }) => ({
      ...n,
      ...(choices ? { choices: JSON.parse(choices) } : {}),
      ...(blocked ? { blocked: true } : {}),
    }));
  },
};
