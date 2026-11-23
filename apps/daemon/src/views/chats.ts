import { type ChatInfo, EV, type IonEvent, stripControl } from "@ion/schema";
import type { Db, View } from "../store/index.js";

type D = Record<string, unknown>;

/** One row per chat: title, project, worktree, branch, archived, and its last run's status. */
export const chatsView: View & {
  list(db: Db): ChatInfo[];
  worktree(db: Db, chatId: string): string | null;
  session(db: Db, chatId: string): { harness: string; sessionId: string } | null;
  /** The agent the project's most recently active chat ran on, if any ran. */
  lastAgent(db: Db, projectId: string): string | null;
} = {
  name: "chats",
  // 6: why a chat ion started waits for a slot (waiting). 7: or for its agent's reset.
  version: 7,
  tables: ["view_chats"],
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS view_chats (
      chat_id TEXT PRIMARY KEY, title TEXT NOT NULL, project_id TEXT, worktree TEXT, branch TEXT,
      archived INTEGER NOT NULL DEFAULT 0, last_run_status TEXT, harness TEXT, session_id TEXT, last_activity TEXT,
      preview TEXT, by TEXT, waiting TEXT)`);
  },
  reset(db) {
    db.exec("DELETE FROM view_chats");
  },
  apply(db, e: IonEvent) {
    if (!e.chatId) return;
    const d = e.data as D;
    if (e.type === EV.chatCreated) {
      db.prepare(
        "INSERT OR IGNORE INTO view_chats (chat_id, title, project_id, worktree, branch, last_activity, by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        e.chatId,
        String(d.title),
        d.projectId ?? null,
        d.worktree ?? null,
        d.branch ?? null,
        e.ts,
        d.by ?? null,
      );
    } else if (e.type === EV.chatRenamed) {
      db.prepare("UPDATE view_chats SET title = ? WHERE chat_id = ?").run(String(d.title), e.chatId);
    } else if (e.type === EV.chatHandoff && d.kind === "waiting") {
      // Waiting for its agent's reset (Plan 20): it reads as waiting, not failed, until a run goes on.
      db.prepare("UPDATE view_chats SET waiting = ? WHERE chat_id = ?").run(String(d.text), e.chatId);
    } else if (e.type === EV.chatHandoff && (d.kind === "failed" || d.kind === "stopped")) {
      // The wait couldn't go on, or you stopped it: it reads as it ended again (final review, 2026-11-23).
      db.prepare("UPDATE view_chats SET waiting = NULL WHERE chat_id = ?").run(e.chatId);
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
             last_activity AS lastActivityAt, preview, by, waiting FROM view_chats ORDER BY rowid`,
        )
        .all() as (Omit<ChatInfo, "archived" | "waiting"> & { archived: number; waiting: string | null })[]
    ).map(({ waiting, ...r }) => ({ ...r, archived: r.archived === 1, ...(waiting ? { waiting } : {}) }));
  },
  lastAgent(db, projectId) {
    const r = db
      .prepare(
        "SELECT harness FROM view_chats WHERE project_id = ? AND harness IS NOT NULL ORDER BY last_activity DESC LIMIT 1",
      )
      .get(projectId) as { harness: string } | undefined;
    return r?.harness ?? null;
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
export function previewOf(text: string): string {
  const plain = stripControl(text)
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
  // Why it waits for a slot, while it's queued.
  if (status) {
    const waiting = status === "queued" && typeof d.waiting === "string" ? d.waiting : null;
    db.prepare("UPDATE view_chats SET waiting = ? WHERE chat_id = ?").run(waiting, chatId);
  }
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
