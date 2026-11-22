import type { AdapterEvent } from "@ion/adapter-kit";
import { EV, type IonEvent, type NewEvent, type UsageWindow } from "@ion/schema";
import type { Db, View } from "../store/index.js";

/** One agent's usage as the view keeps it (how it bills comes from its sign-in, not from here). */
export type AgentUsageRow = {
  today: { tokens: number; costUsd: number };
  week: { tokens: number; costUsd: number };
  windows: UsageWindow[];
  limitedUntil: string | null;
};

/** A limit that doesn't say when it resets: ion waits this long, then tries the agent once more. */
const LIMIT_DEFAULT_MS = 30 * 60_000;
const WEEK_MS = 7 * 86_400_000;

type Data = Record<string, unknown>;
type Limit = { resetsAt?: string };

const harnessOf = (db: Db, runId: string): string | null =>
  (
    db.prepare("SELECT harness FROM view_runs WHERE run_id = ?").get(runId) as
      | { harness: string | null }
      | undefined
  )?.harness ?? null;

function reported(db: Db, e: IonEvent, harness: string, d: Data): void {
  const tokens = Number(d.inputTokens ?? 0) + Number(d.outputTokens ?? 0);
  const cost = typeof d.costUsd === "number" ? d.costUsd : 0;
  db.prepare("INSERT INTO view_usage (run_id, harness, at, tokens, cost) VALUES (?, ?, ?, ?, ?)").run(
    e.runId,
    harness,
    e.ts,
    tokens,
    cost,
  );
  // Its windows as this run reported them: none (it stopped reporting) clears the last ones, never keeps them.
  db.prepare(
    `INSERT INTO view_usage_agents (harness, windows) VALUES (?, ?)
     ON CONFLICT (harness) DO UPDATE SET windows = excluded.windows`,
  ).run(harness, JSON.stringify(Array.isArray(d.windows) ? d.windows : []));
}

/**
 * The agent hit its limit: limited until its reset, else for LIMIT_DEFAULT_MS. One mark per agent: another thread
 * hitting the same limit meanwhile doesn't add one or push it later (only a reset the agent said replaces a guess).
 */
function limited(db: Db, e: IonEvent, harness: string, limit: Limit): void {
  const until = limit.resetsAt ?? new Date(Date.parse(e.ts) + LIMIT_DEFAULT_MS).toISOString();
  const was = db
    .prepare("SELECT limited_until AS until FROM view_usage_agents WHERE harness = ?")
    .get(harness) as { until: string | null } | undefined;
  if (!limit.resetsAt && was?.until && Date.parse(was.until) > Date.parse(e.ts)) return;
  db.prepare(
    `INSERT INTO view_usage_agents (harness, windows, limited_until, limited_at) VALUES (?, '[]', ?, ?)
     ON CONFLICT (harness) DO UPDATE SET limited_until = excluded.limited_until, limited_at = excluded.limited_at`,
  ).run(harness, until, e.ts);
}

/** A run that started after the mark and ended well: the agent got past its limit. */
function cleared(db: Db, runId: string, harness: string): void {
  db.prepare(
    `UPDATE view_usage_agents SET limited_until = NULL, limited_at = NULL WHERE harness = ? AND limited_at <=
       (SELECT started_at FROM view_runs WHERE run_id = ?)`,
  ).run(harness, runId);
}

type Sum = { harness: string; tokens: number; cost: number };
const sums = (db: Db, since: string) =>
  db
    .prepare(
      "SELECT harness, sum(tokens) AS tokens, sum(cost) AS cost FROM view_usage WHERE at >= ? GROUP BY harness",
    )
    .all(since) as Sum[];

const money = (n: number) => Math.round(n * 100) / 100;

/** Each agent's usage, by harness id: tokens and cost (since midnight, the last 7 days), windows, its limit. */
function agents(db: Db, now: Date): Record<string, AgentUsageRow> {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const out: Record<string, AgentUsageRow> = {};
  const row = (h: string) =>
    (out[h] ??= {
      today: { tokens: 0, costUsd: 0 },
      week: { tokens: 0, costUsd: 0 },
      windows: [],
      limitedUntil: null,
    });
  for (const s of sums(db, new Date(now.getTime() - WEEK_MS).toISOString()))
    row(s.harness).week = { tokens: s.tokens, costUsd: money(s.cost) };
  for (const s of sums(db, midnight)) row(s.harness).today = { tokens: s.tokens, costUsd: money(s.cost) };
  const marks = db
    .prepare("SELECT harness, windows, limited_until AS until FROM view_usage_agents")
    .all() as { harness: string; windows: string | null; until: string | null }[];
  for (const m of marks) {
    const r = row(m.harness);
    r.windows = JSON.parse(m.windows ?? "[]") as UsageWindow[];
    r.limitedUntil = m.until && Date.parse(m.until) > now.getTime() ? m.until : null;
  }
  return out;
}

/**
 * What of an ion's turn or the judge's session goes in its agent's ledger (the user, 2026-11-22: ions' spending and
 * limits count too): its usage, and a limit it hit, named with the agent and kept off any chat. Null for the rest.
 */
export function ledgerEvent(harness: string, e: AdapterEvent, runId: string | null): NewEvent | null {
  const limit = e.type === EV.error && !!(e.data as Data).limit;
  if (e.type !== EV.usageReported && !limit) return null;
  return { ...e, data: { ...e.data, harness }, chatId: null, runId, origin: "adapter" };
}

/** Keeps what of a session goes in its agent's ledger (ledgerEvent), for sessions outside a chat's run. */
export const recordTo =
  (store: { append(e: NewEvent): unknown }) =>
  (harness: string, e: AdapterEvent): void => {
    const kept = ledgerEvent(harness, e, null);
    if (kept) store.append(kept);
  };

/** Each agent's usage ledger (tokens, cost, windows) and its limit, from its runs' events. */
export const usageView: View & { agents(db: Db, now: Date): Record<string, AgentUsageRow> } = {
  name: "usage",
  tables: ["view_usage", "view_usage_agents"],
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS view_usage (
      run_id TEXT, harness TEXT NOT NULL, at TEXT NOT NULL, tokens INTEGER NOT NULL, cost REAL NOT NULL)`);
    db.exec("CREATE INDEX IF NOT EXISTS view_usage_at ON view_usage (at)");
    db.exec(`CREATE TABLE IF NOT EXISTS view_usage_agents (
      harness TEXT PRIMARY KEY, windows TEXT, limited_until TEXT, limited_at TEXT)`);
  },
  reset(db) {
    db.exec("DELETE FROM view_usage");
    db.exec("DELETE FROM view_usage_agents");
  },
  apply(db, e) {
    const watched = e.type === EV.usageReported || e.type === EV.error || e.type === EV.runFinished;
    if (!watched) return;
    const d = e.data as Data;
    // An ion's turn or the judge names its agent; a chat's run is known by its run.started.
    const named = typeof d.harness === "string" ? d.harness : null;
    const harness = named ?? (e.runId ? harnessOf(db, e.runId) : null);
    if (!harness) return;
    if (e.type === EV.usageReported) reported(db, e, harness, d);
    else if (e.type === EV.error && d.limit && typeof d.limit === "object")
      limited(db, e, harness, d.limit as Limit);
    else if (e.type === EV.runFinished && d.status === "done" && e.runId) cleared(db, e.runId, harness);
  },
  agents,
};
