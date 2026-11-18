import { type DecisionInfo, type DecisionScope, EV, type IonEvent } from "@ion/schema";
import type { Db, View } from "../store/index.js";

type D = Record<string, unknown>;
type Row = Omit<DecisionInfo, "outcomes">;

const COLUMNS = `decision_id AS decisionId, project_id AS projectId, chat_id AS chatId, question, choice, scope, by,
  decided_at AS decidedAt`;

/** Your decisions (answers to agents' questions) and what happened after each, minus forgotten ones. */
export const decisionsView: View & {
  list(db: Db, projectId?: string): DecisionInfo[];
  /** Those that apply in this chat: its own, its project's, and everywhere ones; newest first. */
  applicable(db: Db, projectId: string, chatId: string): DecisionInfo[];
  find(db: Db, decisionId: string): DecisionInfo | null;
} = {
  name: "decisions",
  version: 1,
  tables: ["view_decisions", "view_decision_outcomes"],
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS view_decisions (
      decision_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, chat_id TEXT, question TEXT NOT NULL,
      choice TEXT NOT NULL, scope TEXT NOT NULL, by TEXT NOT NULL, decided_at TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS view_decision_outcomes (
      decision_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, by TEXT NOT NULL)`);
  },
  reset(db) {
    db.exec("DELETE FROM view_decisions; DELETE FROM view_decision_outcomes");
  },
  apply(db, e: IonEvent) {
    const d = e.data as D;
    if (e.type === EV.decisionRecorded)
      db.prepare(
        `INSERT OR IGNORE INTO view_decisions (decision_id, project_id, chat_id, question, choice, scope, by, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        String(d.decisionId),
        String(d.projectId),
        e.chatId,
        String(d.question),
        String(d.choice),
        String(d.scope),
        String(d.by),
        e.ts,
      );
    else if (e.type === EV.decisionOutcome)
      db.prepare("INSERT INTO view_decision_outcomes (decision_id, kind, text, by) VALUES (?, ?, ?, ?)").run(
        String(d.decisionId),
        String(d.kind),
        String(d.text),
        String(d.by),
      );
    else if (e.type === EV.decisionForgotten) {
      db.prepare("DELETE FROM view_decisions WHERE decision_id = ?").run(String(d.decisionId));
      db.prepare("DELETE FROM view_decision_outcomes WHERE decision_id = ?").run(String(d.decisionId));
    }
  },
  list(db, projectId) {
    const where = projectId ? "WHERE project_id = ? OR scope = 'everywhere'" : "";
    const rows = db
      .prepare(`SELECT ${COLUMNS} FROM view_decisions ${where} ORDER BY rowid`)
      .all(...(projectId ? [projectId] : [])) as Row[];
    return withOutcomes(db, rows);
  },
  applicable(db, projectId, chatId) {
    const rows = db
      .prepare(
        `SELECT ${COLUMNS} FROM view_decisions WHERE scope = 'everywhere'
           OR (scope = 'project' AND project_id = ?) OR (scope = 'chat' AND chat_id = ?) ORDER BY rowid DESC`,
      )
      .all(projectId, chatId) as Row[];
    return withOutcomes(db, rows);
  },
  find(db, decisionId) {
    const row = db.prepare(`SELECT ${COLUMNS} FROM view_decisions WHERE decision_id = ?`).get(decisionId) as
      | Row
      | undefined;
    return row ? withOutcomes(db, [row])[0]! : null;
  },
};

function withOutcomes(db: Db, rows: Row[]): DecisionInfo[] {
  const q = db.prepare(
    "SELECT kind, text, by FROM view_decision_outcomes WHERE decision_id = ? ORDER BY rowid",
  );
  return rows.map((r) => ({
    ...r,
    scope: r.scope as DecisionScope,
    outcomes: q.all(r.decisionId) as DecisionInfo["outcomes"],
  }));
}
