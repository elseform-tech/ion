import type { AgentUsage, HarnessInfo } from "@ion/schema";
import type { AgentUsageRow } from "../views/usage.js";

const NONE = { tokens: 0, costUsd: 0 };

/**
 * Each agent's usage for Settings → Agents and `ion status`: how it bills (from its sign-in; unknown stays null,
 * never free) and what its runs reported. An agent with no runs yet has nothing, not a made-up gauge.
 */
export function agentUsages(infos: HarnessInfo[], rows: Record<string, AgentUsageRow>): AgentUsage[] {
  return infos.map((h) => ({
    harness: h.id,
    label: h.label,
    billing: h.billing ?? null,
    today: rows[h.id]?.today ?? NONE,
    week: rows[h.id]?.week ?? NONE,
    windows: rows[h.id]?.windows ?? [],
    limitedUntil: rows[h.id]?.limitedUntil ?? null,
  }));
}
