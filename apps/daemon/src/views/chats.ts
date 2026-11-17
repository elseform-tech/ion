import { type ChatInfo, EV, type IonEvent } from "@ion/schema";
import type { Db, View } from "../store/index.js";

type D = Record<string, unknown>;

/** One row per chat: title, project, worktree, branch, archived, and its last run's status. */
export const chatsView: View & {
  list(db: Db): ChatInfo[];
  worktree(db: Db, chatId: string): string | null;
  session(db: Db, chatId: string): { harness: string; sessionId: string } | null;
} = {
  name: "chats",
  version: 2,
  tables: ["view_chats"],
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS view_chats (
      chat_id TEXT PRIMARY KEY, title TEXT NOT NULL, project_id TEXT, worktree TEXT, branch TEXT,
      archived INTEGER NOT NULL DEFAULT 0, last_run_status TEXT, harness TEXT, session_id TEXT)`);
  },
  reset(db) {
    db.exec("DELETE FROM view_chats");
  },
  apply(db, e: IonEvent) {
    if (!e.chatId) return;
    const d = e.data as D;
    if (e.type === EV.chatCreated) {
      db.prepare(
        "INSERT OR IGNORE INTO view_chats (chat_id, title, project_id, worktree, branch) VALUES (?, ?, ?, ?, ?)",
      ).run(e.chatId, String(d.title), d.projectId ?? null, d.worktree ?? null, d.branch ?? null);
    } else if (e.type === EV.chatArchived) {
      db.prepare("UPDATE view_chats SET archived = 1 WHERE chat_id = ?").run(e.chatId);
    } else {
      if (e.type === EV.runStarted) noteSession(db, e.chatId, d);
      const status = runStatus(e.type, d);
      if (status)
        db.prepare("UPDATE view_chats SET last_run_status = ? WHERE chat_id = ?").run(status, e.chatId);
    }
  },
  list(db) {
    return (
      db
        .prepare(
          `SELECT chat_id AS chatId, title, project_id AS projectId, branch, archived, last_run_status AS lastRunStatus
           FROM view_chats ORDER BY rowid`,
        )
        .all() as (Omit<ChatInfo, "archived"> & { archived: number })[]
    ).map((r) => ({ ...r, archived: r.archived === 1 }));
  },
  session(db, chatId) {
    const r = db
      .prepare("SELECT harness, session_id AS sessionId FROM view_chats WHERE chat_id = ?")
      .get(chatId) as { harness: string | null; sessionId: string | null } | undefined;
    return r?.harness && r.sessionId ? { harness: r.harness, sessionId: r.sessionId } : null;
  },
  worktree(db, chatId) {
    const r = db.prepare("SELECT worktree FROM view_chats WHERE chat_id = ?").get(chatId) as
      | { worktree: string | null }
      | undefined;
    return r?.worktree ?? null;
  },
};

/** The chat's last run status from a run event, or null for other events. */
function runStatus(type: string, d: Record<string, unknown>): string | null {
  if (type === EV.runFinished) return String(d.status);
  if (type === EV.runQueued) return "queued";
  if (type === EV.runStarted) return "running";
  return null;
}

/** The chat's harness and session, from its latest run.started. */
function noteSession(db: Db, chatId: string, d: Record<string, unknown>): void {
  const sessionId = typeof d.sessionId === "string" ? d.sessionId : null;
  db.prepare("UPDATE view_chats SET harness = ?, session_id = ? WHERE chat_id = ?").run(
    String(d.harness),
    sessionId,
    chatId,
  );
}
