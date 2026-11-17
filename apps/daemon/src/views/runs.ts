import { type IonEvent, RUN_END_STATUSES } from "@ion/schema";
import type { Db, View } from "../store/index.js";

export type RunRow = {
  runId: string;
  chatId: string | null;
  status: string;
  harness: string | null;
  model: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

const ended = new Set<string>(RUN_END_STATUSES);

/** One row per run: its latest status. */
export const runsView: View & { rows(db: Db): RunRow[] } = {
  name: "runs",
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS view_runs (
      run_id TEXT PRIMARY KEY, chat_id TEXT, status TEXT NOT NULL,
      harness TEXT, model TEXT, started_at TEXT, finished_at TEXT)`);
  },
  reset(db) {
    db.exec("DELETE FROM view_runs");
  },
  apply(db, e: IonEvent) {
    if (!e.runId) return;
    const d = e.data as Record<string, unknown>;
    if (e.type === "run.queued" || e.type === "run.started") {
      db.prepare(
        `INSERT INTO view_runs (run_id, chat_id, status, harness, model, started_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id) DO UPDATE SET status = excluded.status,
           harness = coalesce(excluded.harness, harness), model = coalesce(excluded.model, model),
           started_at = coalesce(excluded.started_at, started_at)`,
      ).run(
        e.runId,
        e.chatId,
        e.type === "run.started" ? "running" : "queued",
        (d.harness as string) ?? null,
        (d.model as string) ?? null,
        e.type === "run.started" ? e.ts : null,
      );
    } else if (e.type === "run.finished" && ended.has(d.status as string)) {
      db.prepare("UPDATE view_runs SET status = ?, finished_at = ? WHERE run_id = ?").run(
        d.status,
        e.ts,
        e.runId,
      );
    }
  },
  rows(db) {
    return db
      .prepare(
        `SELECT run_id AS runId, chat_id AS chatId, status, harness, model, started_at AS startedAt,
                finished_at AS finishedAt FROM view_runs ORDER BY run_id`,
      )
      .all() as RunRow[];
  },
};
