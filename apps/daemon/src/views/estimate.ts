import type { Billing, TaskEstimate, UsageWindow } from "@ion/schema";
import type { Db } from "../store/index.js";
import { windowShares } from "./window-shares.js";

/**
 * What a task usually takes, from your past chats (the user, 2026-11-21; "verify, don't guess", 2026-11-22): only from
 * usage the agents really reported, never a guess. The rule, kept simple:
 *
 * - Similar chats: the same project, the same agent, the same kind and a request of the same length band. Both are
 *   read from your first message the same way for past chats and for the new request (`kindOf`): a request ending in
 *   "?" is a question, anything else a change; its length is its trimmed characters, in LENGTH_BANDS.
 * - A chat whose runs span agents (it went on on another after a limit) did only part of its work on each: left out.
 * - A chat's total is every token all its runs on that agent processed (cached context too). An agent whose count is
 *   partial (opencode over ACP: a turn's last step only) has no total, so it never shows a token estimate.
 * - The range is the median to the p90. Fewer than MIN_SIMILAR similar chats that can say: no estimate.
 * - Shown as cost for an agent paid per token (when its chats reported a cost), as a share of a window when the agent
 *   reports that window now and its past chats moved it (views/window-shares.ts), else as tokens.
 */
const MIN_SIMILAR = 5;

/** Request lengths in characters: short (under 200), medium (under 1000), long. */
const LENGTH_BANDS = [200, 1000];

/** What a request is, as estimates compare them: a question or a change, and its length band. */
function kindOf(text: string): string {
  const t = text.trim();
  const band = LENGTH_BANDS.filter((b) => t.length >= b).length;
  return `${t.endsWith("?") ? "question" : "change"}:${band}`;
}

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

/** A past chat: its total tokens (null: a run's count was partial), its cost, your first message. */
type Past = { chatId: string; total: number | null; cost: number; text: string | null };

/** The project's past chats on the agent. */
function pastChats(db: Db, q: EstimateAsk): Past[] {
  return db
    .prepare(
      `SELECT u.chat_id AS chatId, CASE WHEN count(u.total) = count(*) THEN sum(u.total) END AS total,
         sum(u.cost) AS cost,
         (SELECT m.text FROM view_messages m WHERE m.chat_id = u.chat_id AND m.role = 'you' ORDER BY m.id LIMIT 1)
           AS text
       FROM view_usage u JOIN view_chats c ON c.chat_id = u.chat_id
       WHERE u.harness = ? AND c.project_id = ? AND u.chat_id != ?
         AND NOT EXISTS (SELECT 1 FROM view_usage o WHERE o.chat_id = u.chat_id AND o.harness != u.harness)
       GROUP BY u.chat_id`,
    )
    .all(q.harness, q.projectId, q.exclude ?? "") as Past[];
}

/** Nearest-rank percentile of sorted values. */
const rank = (sorted: number[], p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;

/** The median to the p90 of some values, or null with too few to say. */
function range(values: number[]): { low: number; high: number } | null {
  if (values.length < MIN_SIMILAR) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { low: rank(sorted, 0.5), high: rank(sorted, 0.9) };
}

/** Share of the window the agent reports now, from similar chats that moved it; null when too few can say. */
function shareOf(db: Db, q: EstimateAsk, similar: Past[], agent: AgentNow): TaskEstimate | null {
  const window = agent.windows[0]?.name;
  if (!window) return null;
  const moved = windowShares(
    db,
    q.harness,
    window,
    similar.map((c) => c.chatId),
  );
  const r = range([...moved.values()]);
  return r ? { unit: "percent", ...r, window } : null;
}

/** What the task usually takes on the agent, from similar past chats in the project; null with too few. */
export function estimateOf(db: Db, q: EstimateAsk, agent: AgentNow): TaskEstimate | null {
  const kind = kindOf(q.text);
  const similar = pastChats(db, q).filter((c) => kindOf(c.text ?? "") === kind);
  if (similar.length < MIN_SIMILAR) return null;
  const costs = range(similar.map((c) => c.cost));
  if (agent.billing === "api" && costs && similar.every((c) => c.cost > 0)) return { unit: "usd", ...costs };
  const share = shareOf(db, q, similar, agent);
  if (share) return share;
  const tokens = range(similar.flatMap((c) => (c.total ? [c.total] : [])));
  return tokens ? { unit: "tokens", ...tokens } : null;
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
