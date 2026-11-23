import type { UsageWindow } from "@ion/schema";
import type { Db } from "../store/index.js";

/** An agent's reset time wobbles by a few seconds between reports: within this, it's the same window period. */
const SAME_RESET_MS = 60_000;

const samePeriod = (a: string | null, b: string | null) =>
  !!a && !!b && Math.abs(Date.parse(a) - Date.parse(b)) <= SAME_RESET_MS;

const windowIn = (json: string | null, name: string) =>
  (JSON.parse(json ?? "[]") as UsageWindow[]).find((w) => w.name === name);

/** How far a report moved the window since the one just before it, in the same period; null when it can't say. */
function moved(now: UsageWindow | undefined, before: UsageWindow | undefined): number | null {
  if (!now || !before || !samePeriod(now.resetsAt, before.resetsAt)) return null;
  return now.usedPercent >= before.usedPercent ? now.usedPercent - before.usedPercent : null;
}

/**
 * The chats among these that ran alongside other work on the agent (another run, or an ion's turn reporting usage
 * meanwhile): what they alone used of a window can't be told.
 */
function overlapping(db: Db, harness: string, chatIds: string[]): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT a.chat_id AS chatId FROM view_runs a
       WHERE a.harness = ? AND a.chat_id IN (SELECT value FROM json_each(?)) AND (
         EXISTS (SELECT 1 FROM view_runs b WHERE b.harness = a.harness AND b.run_id != a.run_id
           AND b.started_at < coalesce(a.finished_at, '9999') AND coalesce(b.finished_at, '9999') > a.started_at)
         OR EXISTS (SELECT 1 FROM view_usage u WHERE u.harness = a.harness AND u.chat_id IS NULL
           AND u.at > a.started_at AND u.at < coalesce(a.finished_at, '9999')))`,
    )
    .all(harness, JSON.stringify(chatIds)) as { chatId: string }[];
  return new Set(rows.map((r) => r.chatId));
}

type Row = { chatId: string; windows: string | null; before: string | null };

/**
 * How far each of these chats moved one of the agent's windows: per run, its used percent less the agent's report
 * just before it (any run or ion turn), in the same window period. A chat with a run that can't say (no window, a
 * reset between, a run alongside other work) has none.
 */
export function windowShares(
  db: Db,
  harness: string,
  window: string,
  chatIds: string[],
): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT chatId, windows, before FROM (
         SELECT chat_id AS chatId, windows, lag(windows) OVER (ORDER BY rowid) AS before
         FROM view_usage WHERE harness = ?)
       WHERE chatId IN (SELECT value FROM json_each(?))`,
    )
    .all(harness, JSON.stringify(chatIds)) as Row[];
  const skip = overlapping(db, harness, chatIds);
  const sums = new Map<string, number | null>();
  for (const r of rows) {
    const m = skip.has(r.chatId) ? null : moved(windowIn(r.windows, window), windowIn(r.before, window));
    const was = sums.has(r.chatId) ? sums.get(r.chatId)! : 0;
    sums.set(r.chatId, was === null || m === null ? null : was + m);
  }
  const out = new Map<string, number>();
  for (const [chatId, s] of sums) if (s !== null) out.set(chatId, s);
  return out;
}
