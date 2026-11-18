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
  version: 4,
  tables: ["view_chats"],
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS view_chats (
      chat_id TEXT PRIMARY KEY, title TEXT NOT NULL, project_id TEXT, worktree TEXT, branch TEXT,
      archived INTEGER NOT NULL DEFAULT 0, last_run_status TEXT, harness TEXT, session_id TEXT, last_activity TEXT,
      preview TEXT)`);
  },
  reset(db) {
    db.exec("DELETE FROM view_chats");
  },
  apply(db, e: IonEvent) {
    if (!e.chatId) return;
    const d = e.data as D;
    if (e.type === EV.chatCreated) {
      db.prepare(
        "INSERT OR IGNORE INTO view_chats (chat_id, title, project_id, worktree, branch, last_activity) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(e.chatId, String(d.title), d.projectId ?? null, d.worktree ?? null, d.branch ?? null, e.ts);
    } else if (e.type === EV.chatArchived) {
      db.prepare("UPDATE view_chats SET archived = 1 WHERE chat_id = ?").run(e.chatId);
    } else {
      noteRun(db, e, d);
    }
  },
  list(db) {
    return (
      db
        .prepare(
          `SELECT chat_id AS chatId, title, project_id AS projectId, branch, archived, last_run_status AS lastRunStatus,
             last_activity AS lastActivityAt, preview FROM view_chats ORDER BY rowid`,
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

const PREVIEW_MAX = 120;

/** The start of a reply, as one line of plain words: Markdown marks and line breaks go. */
function previewOf(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > PREVIEW_MAX ? `${plain.slice(0, PREVIEW_MAX - 1).trimEnd()}…` : plain;
}

/** What counts as a chat being active: a message, or a run starting or ending. */
const ACTIVITY = new Set<string>([EV.messageSent, EV.runStarted, EV.runFinished]);

/** The chat's last run status from a run event, or null for other events. */
function runStatus(type: string, d: Record<string, unknown>): string | null {
  if (type === EV.runFinished) return String(d.status);
  if (type === EV.runQueued) return "queued";
  if (type === EV.runStarted) return "running";
  return null;
}

/** What a run or message changes on its chat: its session, reply preview, last activity and run status. */
function noteRun(db: Db, e: IonEvent, d: D): void {
  const chatId = e.chatId!;
  if (e.type === EV.runStarted) noteSession(db, chatId, d);
  if (e.type === EV.messageCompleted)
    db.prepare("UPDATE view_chats SET preview = ? WHERE chat_id = ?").run(previewOf(String(d.text)), chatId);
  if (ACTIVITY.has(e.type))
    db.prepare("UPDATE view_chats SET last_activity = ? WHERE chat_id = ?").run(e.ts, chatId);
  const status = runStatus(e.type, d);
  if (status) db.prepare("UPDATE view_chats SET last_run_status = ? WHERE chat_id = ?").run(status, chatId);
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
