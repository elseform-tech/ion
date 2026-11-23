import type { AdapterEvent } from "@ion/adapter-kit";
import { EV, type IonEvent, type NewEvent, type UsageWindow } from "@ion/schema";
import type { Db, View } from "../store/index.js";

/** One agent's usage as the view keeps it (how it bills comes from its sign-in, not from here). */
export type AgentUsageRow = {
  today: { tokens: number; costUsd: number };
  week: { tokens: number; costUsd: number };
  windows: UsageWindow[];
  limitedUntil: string | null;
  /** The models it ran in the last 7 days (how it bills follows them). */
  models: string[];
  /** The limit didn't say when it resets: limitedUntil is ion's guess (it may be free sooner; trying tells). */
  limitGuessed?: true;
};

/** The furthest ahead an agent's reset is believed: a later one waits this long, then ion tries again. */
const RESET_MAX_MS = 7 * 86_400_000;

/**
 * An agent's reset time, checked before ion marks or waits on it (security scan, 2026-11-23): one that isn't a date,
 * or is already past, is unknown (undefined: ion's guess, then a try); one further than 7 days ahead is 7 days ahead.
 */
export function agentReset(resetsAt: unknown, nowMs: number): string | undefined {
  if (typeof resetsAt !== "string") return undefined;
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at) || at <= nowMs) return undefined;
  return new Date(Math.min(at, nowMs + RESET_MAX_MS)).toISOString();
}

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
  // Every token it processed when the agent counts them all; else what it said (a partial count has no total).
  const total = typeof d.totalTokens === "number" ? d.totalTokens : null;
  const tokens = total ?? Number(d.inputTokens ?? 0) + Number(d.outputTokens ?? 0);
  const cost = typeof d.costUsd === "number" ? d.costUsd : 0;
  const model = typeof d.model === "string" ? d.model : null;
  // Its chat and the windows as it reported them: what estimates learn from (views/estimate.ts).
  const windows = Array.isArray(d.windows) && d.windows.length ? JSON.stringify(d.windows) : null;
  db.prepare(
    `INSERT INTO view_usage (run_id, chat_id, harness, at, tokens, total, cost, model, windows)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(e.runId, e.chatId, harness, e.ts, tokens, total, cost, model, windows);
  // Its windows as this run reported them: none (it stopped reporting) clears the last ones, never keeps them.
  db.prepare(
    `INSERT INTO view_usage_agents (harness, windows) VALUES (?, ?)
     ON CONFLICT (harness) DO UPDATE SET windows = excluded.windows`,
  ).run(harness, JSON.stringify(Array.isArray(d.windows) ? d.windows : []));
}

/** With no window to check against, a stated reset is believed this far ahead at most. */
const NO_WINDOW_MAX_MS = 6 * 3_600_000;

/** The latest reset among the agent's reported windows still ahead (ms), or null when it reports none. */
function latestWindow(db: Db, harness: string, nowMs: number): number | null {
  const r = db.prepare("SELECT windows FROM view_usage_agents WHERE harness = ?").get(harness) as
    | { windows: string | null }
    | undefined;
  const windows = JSON.parse(r?.windows ?? "[]") as UsageWindow[];
  const ends = windows
    .map((w) => Date.parse(w.resetsAt ?? ""))
    .filter((t) => Number.isFinite(t) && t > nowMs);
  return ends.length ? Math.max(...ends) : null;
}

/**
 * The reset an agent said, as ion believes it (security scan follow-up, 2026-11-23: verify, don't guess): checked
 * (agentReset), then within the agent's longest reported window, or 6 hours when it reports none. Later than that,
 * it's unknown (ion's guess, then a try). `inWindow`: it falls within a window the agent reported.
 */
export function believedReset(
  db: Db,
  harness: string,
  said: unknown,
  nowMs: number,
): { resetsAt?: string; inWindow?: true } {
  const resetsAt = agentReset(said, nowMs);
  if (!resetsAt) return {};
  const at = Date.parse(resetsAt);
  const latest = latestWindow(db, harness, nowMs);
  if (latest !== null) return at <= latest + 60_000 ? { resetsAt, inWindow: true } : {};
  return at <= nowMs + NO_WINDOW_MAX_MS ? { resetsAt } : {};
}

/**
 * The agent hit its limit: limited until the reset ion believes (believedReset), else for LIMIT_DEFAULT_MS. One mark
 * per agent: another thread hitting the same limit meanwhile doesn't add one or push it later (a stated reset replaces
 * a guess; it pushes a stated mark later only when it falls within a window the agent reported).
 */
function limited(db: Db, e: IonEvent, harness: string, said: Limit): void {
  const now = Date.parse(e.ts);
  const limit = believedReset(db, harness, said.resetsAt, now);
  const until = limit.resetsAt ?? new Date(now + LIMIT_DEFAULT_MS).toISOString();
  const was = db
    .prepare("SELECT limited_until AS until, guessed FROM view_usage_agents WHERE harness = ?")
    .get(harness) as { until: string | null; guessed: number | null } | undefined;
  const marked = !!was?.until && Date.parse(was.until) > now;
  if (marked && !limit.resetsAt) return;
  const later = marked && was?.guessed === 0 && Date.parse(until) > Date.parse(was.until ?? "");
  if (later && !limit.inWindow) return;
  db.prepare(
    `INSERT INTO view_usage_agents (harness, windows, limited_until, limited_at, guessed) VALUES (?, '[]', ?, ?, ?)
     ON CONFLICT (harness) DO UPDATE SET limited_until = excluded.limited_until, limited_at = excluded.limited_at,
       guessed = excluded.guessed`,
  ).run(harness, until, e.ts, limit.resetsAt ? 0 : 1);
}

/** A run that started after the mark and ended well: the agent got past its limit. */
function cleared(db: Db, harness: string, startedAt: string | null): void {
  if (!startedAt) return;
  db.prepare(
    "UPDATE view_usage_agents SET limited_until = NULL, limited_at = NULL WHERE harness = ? AND limited_at <= ?",
  ).run(harness, startedAt);
}

/** When the run or turn that ended started: an ion's turn says so; a chat's run is in view_runs. */
function startOf(db: Db, e: IonEvent, d: Data): string | null {
  if (typeof d.startedAt === "string") return d.startedAt;
  if (!e.runId) return null;
  const r = db.prepare("SELECT started_at AS at FROM view_runs WHERE run_id = ?").get(e.runId) as
    | { at: string | null }
    | undefined;
  return r?.at ?? null;
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
      models: [],
    });
  for (const s of sums(db, new Date(now.getTime() - WEEK_MS).toISOString()))
    row(s.harness).week = { tokens: s.tokens, costUsd: money(s.cost) };
  for (const s of sums(db, midnight)) row(s.harness).today = { tokens: s.tokens, costUsd: money(s.cost) };
  const ran = db
    .prepare(
      "SELECT DISTINCT harness, model FROM view_usage WHERE at >= ? AND model IS NOT NULL ORDER BY harness, model",
    )
    .all(new Date(now.getTime() - WEEK_MS).toISOString()) as { harness: string; model: string }[];
  for (const r of ran) row(r.harness).models.push(r.model);
  const marks = db
    .prepare("SELECT harness, windows, limited_until AS until, guessed FROM view_usage_agents")
    .all() as { harness: string; windows: string | null; until: string | null; guessed: number | null }[];
  for (const m of marks) {
    const r = row(m.harness);
    r.windows = JSON.parse(m.windows ?? "[]") as UsageWindow[];
    r.limitedUntil = m.until && Date.parse(m.until) > now.getTime() ? m.until : null;
    if (r.limitedUntil && m.guessed === 1) r.limitGuessed = true;
  }
  return out;
}

/**
 * What of an ion's turn or the judge's session goes in its agent's ledger (the user, 2026-11-22: ions' spending and
 * limits count too): its usage, and a limit it hit, named with the agent and kept off any chat. Null for the rest.
 */
export function ledgerEvent(
  harness: string,
  e: AdapterEvent,
  s: { runId: string | null; startedAt: string },
): NewEvent | null {
  const d = e.data as Data;
  const limit = e.type === EV.error && !!d.limit;
  // One that ended well, with when it started: it clears a mark made before it (the agent is past its limit).
  const done = e.type === EV.runFinished && d.status === "done";
  if (e.type !== EV.usageReported && !limit && !done) return null;
  const data = { ...e.data, harness, ...(done ? { startedAt: s.startedAt } : {}) };
  return { ...e, data, chatId: null, runId: s.runId, origin: "adapter" };
}

/** Keeps what of a session goes in its agent's ledger (ledgerEvent), for sessions outside a chat's run. */
export const recordTo =
  (store: { append(e: NewEvent): unknown }) =>
  (harness: string, e: AdapterEvent, startedAt: string): void => {
    const kept = ledgerEvent(harness, e, { runId: null, startedAt });
    if (kept) store.append(kept);
  };

/** Each agent's usage ledger (tokens, cost, windows) and its limit, from its runs' events. */
export const usageView: View & { agents(db: Db, now: Date): Record<string, AgentUsageRow> } = {
  name: "usage",
  // 2: a limit's mark says whether its reset was guessed. 3: each usage row's model. 4: its chat and windows
  // (estimates). 5: its total (every token, cached context too; none when the agent's count is partial).
  version: 5,
  // view_usage_edits: version 4's, dropped.
  tables: ["view_usage", "view_usage_agents", "view_usage_edits"],
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS view_usage (
      run_id TEXT, chat_id TEXT, harness TEXT NOT NULL, at TEXT NOT NULL, tokens INTEGER NOT NULL, total INTEGER,
      cost REAL NOT NULL, model TEXT, windows TEXT)`);
    db.exec("CREATE INDEX IF NOT EXISTS view_usage_chat ON view_usage (harness, chat_id)");
    db.exec("CREATE INDEX IF NOT EXISTS view_usage_at ON view_usage (at)");
    db.exec(`CREATE TABLE IF NOT EXISTS view_usage_agents (
      harness TEXT PRIMARY KEY, windows TEXT, limited_until TEXT, limited_at TEXT, guessed INTEGER)`);
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
    else if (e.type === EV.runFinished && d.status === "done") cleared(db, harness, startOf(db, e, d));
  },
  agents,
};
