import { EV, type IonEvent, RUN_END_STATUSES } from "@ion/schema";
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

export type RunSince = {
  runId: string;
  chatId: string;
  status: string;
  cost: number | null;
  startedAt: string;
};

const ended = new Set<string>(RUN_END_STATUSES);

/** One row per run: its latest status. */
/** Some chats' runs over the last 30 days: how many, how many succeeded, their cost, and runs per day (oldest first). */
export type RunStats = { runs: number; succeeded: number; costUsd: number; perDay: number[] };

const DAYS = 30;
const DAY_MS = 86_400_000;

export const runsView: View & {
  rows(db: Db): RunRow[];
  stats(db: Db, chatIds: string[], now: Date): RunStats;
  /** Some chats' runs that started at or after `since` (ISO), newest first. */
  since(db: Db, chatIds: string[], since: string): RunSince[];
} = {
  name: "runs",
  version: 2,
  tables: ["view_runs"],
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS view_runs (
      run_id TEXT PRIMARY KEY, chat_id TEXT, status TEXT NOT NULL,
      harness TEXT, model TEXT, started_at TEXT, finished_at TEXT, cost REAL)`);
  },
  reset(db) {
    db.exec("DELETE FROM view_runs");
  },
  apply(db, e: IonEvent) {
    if (!e.runId) return;
    const d = e.data as Record<string, unknown>;
    if (e.type === EV.runQueued || e.type === EV.runStarted) {
      db.prepare(
        `INSERT INTO view_runs (run_id, chat_id, status, harness, model, started_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id) DO UPDATE SET status = excluded.status,
           harness = coalesce(excluded.harness, harness), model = coalesce(excluded.model, model),
           started_at = coalesce(excluded.started_at, started_at)`,
      ).run(
        e.runId,
        e.chatId,
        e.type === EV.runStarted ? "running" : "queued",
        (d.harness as string) ?? null,
        (d.model as string) ?? null,
        e.type === EV.runStarted ? e.ts : null,
      );
    } else if (e.type === EV.usageReported && typeof d.costUsd === "number") {
      db.prepare("UPDATE view_runs SET cost = coalesce(cost, 0) + ? WHERE run_id = ?").run(
        d.costUsd,
        e.runId,
      );
    } else if (e.type === EV.runFinished && ended.has(d.status as string)) {
      db.prepare("UPDATE view_runs SET status = ?, finished_at = ? WHERE run_id = ?").run(
        d.status,
        e.ts,
        e.runId,
      );
    }
  },
  stats(db, chatIds, now) {
    const since = new Date(now.getTime() - DAYS * DAY_MS).toISOString();
    const marks = chatIds.map(() => "?").join(",");
    const rows = chatIds.length
      ? (db
          .prepare(
            `SELECT status, cost, started_at AS at FROM view_runs WHERE chat_id IN (${marks}) AND started_at >= ?`,
          )
          .all(...chatIds, since) as { status: string; cost: number | null; at: string }[])
      : [];
    const perDay = Array<number>(DAYS).fill(0);
    for (const r of rows) {
      const ago = Math.floor((now.getTime() - Date.parse(r.at)) / DAY_MS);
      if (ago >= 0 && ago < DAYS) perDay[DAYS - 1 - ago]! += 1;
    }
    return {
      runs: rows.length,
      succeeded: rows.filter((r) => r.status === "done").length,
      costUsd: Math.round(rows.reduce((n, r) => n + (r.cost ?? 0), 0) * 100) / 100,
      perDay,
    };
  },
  since(db, chatIds, since) {
    if (!chatIds.length) return [];
    const marks = chatIds.map(() => "?").join(",");
    return db
      .prepare(
        `SELECT run_id AS runId, chat_id AS chatId, status, cost, started_at AS startedAt FROM view_runs
         WHERE chat_id IN (${marks}) AND started_at >= ? ORDER BY started_at DESC, rowid DESC`,
      )
      .all(...chatIds, since) as RunSince[];
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
