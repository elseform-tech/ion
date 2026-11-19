import { EV, type IonEvent } from "@ion/schema";
import type { Db, View } from "../store/index.js";

type Ran = { projectId: string; routineId: string; name: string; due: string | null; chatId?: string };

/** Each time a routine ran (or its slot was skipped): the last slot each one had, and the threads routines started. */
export const routinesView: View & {
  /** The last slot (ISO) the schedule handled for this routine; null: none yet. */
  lastDue(db: Db, projectId: string, routineId: string): string | null;
  /** The name of the routine that started each thread. */
  threads(db: Db): Map<string, string>;
} = {
  name: "routines",
  version: 1,
  tables: ["view_routine_runs"],
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS view_routine_runs (
      project_id TEXT NOT NULL, routine_id TEXT NOT NULL, name TEXT NOT NULL, due TEXT, chat_id TEXT)`);
  },
  reset(db) {
    db.exec("DELETE FROM view_routine_runs");
  },
  apply(db, e: IonEvent) {
    if (e.type !== EV.routineRan) return;
    const d = e.data as Ran;
    db.prepare(
      "INSERT INTO view_routine_runs (project_id, routine_id, name, due, chat_id) VALUES (?, ?, ?, ?, ?)",
    ).run(d.projectId, d.routineId, d.name, d.due, d.chatId ?? null);
  },
  lastDue(db, projectId, routineId) {
    const r = db
      .prepare("SELECT max(due) AS due FROM view_routine_runs WHERE project_id = ? AND routine_id = ?")
      .get(projectId, routineId) as { due: string | null };
    return r.due;
  },
  threads(db) {
    const rows = db
      .prepare("SELECT chat_id AS chatId, name FROM view_routine_runs WHERE chat_id IS NOT NULL")
      .all() as { chatId: string; name: string }[];
    return new Map(rows.map((r) => [r.chatId, r.name]));
  },
};
