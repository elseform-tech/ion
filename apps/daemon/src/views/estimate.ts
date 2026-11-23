import type { Billing, TaskEstimate, UsageWindow } from "@ion/schema";
import type { Db } from "../store/index.js";

/**
 * What a task usually takes, from your past chats (the user, 2026-11-21; "verify, don't guess", 2026-11-22): only from
 * usage the agents really reported, never a guess. The rule, kept simple:
 *
 * - Similar chats: the same project, the same agent, the same kind (an edit changed files; a question didn't) and a
 *   request of the same length band (LENGTH_BANDS, in characters of your first message).
 * - A chat's total is all its runs on that agent. The range is the median to the p90 of the similar chats' totals.
 * - Fewer than MIN_SIMILAR similar chats: no estimate.
 * - Shown as cost for an agent paid per token (when its chats reported a cost), as a share of a window when the agent
 *   reports that window now and its past chats did too (how far each one moved it), else as tokens.
 */
const MIN_SIMILAR = 5;

/** Request lengths in characters: short (under 200), medium (under 1000), long. */
const LENGTH_BANDS = [200, 1000];
const band = (chars: number) => LENGTH_BANDS.filter((b) => chars >= b).length;

/** A request reads as a question when it ends with "?" or opens with a question word; else it's an edit. */
const QUESTION = /^(what|why|how|where|when|which|who|explain)\b/i;
const isQuestion = (text: string) => text.trim().endsWith("?") || QUESTION.test(text.trim());

export type EstimateAsk = {
  projectId: string;
  harness: string;
  /** Your request (its length and kind). */
  text: string;
  /** A chat left out: the one being estimated. */
  exclude?: string;
};

/** How the agent bills and the windows it reports now. */
export type AgentNow = { billing: Billing | null; windows: UsageWindow[] };

type Past = { chatId: string; tokens: number; cost: number; edited: number; request: number | null };

/** The project's past chats on the agent: each one's total tokens and cost, whether it changed files, its request. */
function pastChats(db: Db, q: EstimateAsk): Past[] {
  return db
    .prepare(
      `SELECT u.chat_id AS chatId, sum(u.tokens) AS tokens, sum(u.cost) AS cost,
         EXISTS (SELECT 1 FROM view_usage_edits e WHERE e.chat_id = u.chat_id) AS edited,
         (SELECT length(m.text) FROM view_messages m WHERE m.chat_id = u.chat_id AND m.role = 'you'
            ORDER BY m.id LIMIT 1) AS request
       FROM view_usage u JOIN view_chats c ON c.chat_id = u.chat_id
       WHERE u.harness = ? AND c.project_id = ? AND u.chat_id != ?
       GROUP BY u.chat_id`,
    )
    .all(q.harness, q.projectId, q.exclude ?? "") as Past[];
}

type Row = { chatId: string | null; windows: string | null };

/** How far a report moved the window since the last one, in the same period; null when it can't say. */
function movedSince(w: UsageWindow | undefined, last: UsageWindow | undefined): number | null {
  if (!w || !last || !w.resetsAt || w.resetsAt !== last.resetsAt) return null;
  return w.usedPercent >= last.usedPercent ? w.usedPercent - last.usedPercent : null;
}

/**
 * How far each chat moved one of the agent's windows: per run, its used percent less the one reported just before
 * (any run or ion turn on the agent) in the same window period (the same reset). A chat with a run that can't say
 * (no window, the first report, a reset between) has none.
 */
function shares(db: Db, harness: string, window: string): Map<string, number | null> {
  const rows = db
    .prepare("SELECT chat_id AS chatId, windows FROM view_usage WHERE harness = ? ORDER BY rowid")
    .all(harness) as Row[];
  const out = new Map<string, number | null>();
  let last: UsageWindow | undefined;
  for (const r of rows) {
    const w = (JSON.parse(r.windows ?? "[]") as UsageWindow[]).find((x) => x.name === window);
    const moved = movedSince(w, last);
    if (w) last = w;
    if (!r.chatId) continue;
    const was = out.has(r.chatId) ? out.get(r.chatId)! : 0;
    out.set(r.chatId, was === null || moved === null ? null : was + moved);
  }
  return out;
}

/** Nearest-rank percentile of sorted values. */
const rank = (sorted: number[], p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;

/** The median to the p90 of some values. */
function range(values: number[]): { low: number; high: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return { low: rank(sorted, 0.5), high: rank(sorted, 0.9) };
}

/** Share of the window the agent reports now, from similar chats that moved it; null when too few can say. */
function shareOf(db: Db, q: EstimateAsk, similar: Past[], agent: AgentNow): TaskEstimate | null {
  const window = agent.windows[0]?.name;
  if (!window) return null;
  const moved = shares(db, q.harness, window);
  const known = similar.map((c) => moved.get(c.chatId)).filter((s): s is number => typeof s === "number");
  return known.length >= MIN_SIMILAR ? { unit: "percent", ...range(known), window } : null;
}

/** What the task usually takes on the agent, from similar past chats in the project; null with too few. */
export function estimateOf(db: Db, q: EstimateAsk, agent: AgentNow): TaskEstimate | null {
  const edit = !isQuestion(q.text);
  const similar = pastChats(db, q).filter(
    (c) => c.tokens > 0 && !!c.edited === edit && band(c.request ?? 0) === band(q.text.trim().length),
  );
  if (similar.length < MIN_SIMILAR) return null;
  if (agent.billing === "api" && similar.every((c) => c.cost > 0))
    return { unit: "usd", ...range(similar.map((c) => c.cost)) };
  return shareOf(db, q, similar, agent) ?? { unit: "tokens", ...range(similar.map((c) => c.tokens)) };
}

/** A chat already started, as an estimate asks: its project, the agent it first ran on, your first message. */
export function chatAsk(db: Db, chatId: string): EstimateAsk | null {
  const r = db
    .prepare(
      `SELECT c.project_id AS projectId,
         (SELECT harness FROM view_runs WHERE chat_id = c.chat_id AND harness IS NOT NULL ORDER BY rowid LIMIT 1)
           AS harness,
         (SELECT text FROM view_messages WHERE chat_id = c.chat_id AND role = 'you' ORDER BY id LIMIT 1) AS text
       FROM view_chats c WHERE c.chat_id = ?`,
    )
    .get(chatId) as { projectId: string | null; harness: string | null; text: string | null } | undefined;
  if (!r?.projectId || !r.harness || !r.text) return null;
  return { projectId: r.projectId, harness: r.harness, text: r.text, exclude: chatId };
}
