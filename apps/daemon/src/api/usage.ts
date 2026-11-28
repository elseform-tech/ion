import type { AgentUsage, Billing, HarnessInfo } from "@ion/schema";
import type { AgentUsageRow } from "../views/usage.js";

const NONE = { tokens: 0, costUsd: 0 };

/**
 * Each agent's usage for Settings → Agents and `ion status`: how it bills (from its sign-in; unknown stays null,
 * never free) and what its runs reported. An agent with no runs yet has nothing, not a made-up gauge.
 */
export function agentUsages(
  infos: HarnessInfo[],
  rows: Record<string, AgentUsageRow>,
  billed: Record<string, Billing | null> = {},
): AgentUsage[] {
  return infos.map((h) => ({
    harness: h.id,
    label: h.label,
    billing: h.id in billed ? billed[h.id]! : (h.billing ?? null),
    today: rows[h.id]?.today ?? NONE,
    week: rows[h.id]?.week ?? NONE,
    windows: rows[h.id]?.windows ?? [],
    limitedUntil: rows[h.id]?.limitedUntil ?? null,
  }));
}

/** An agent that can say how models bill (adapters' `billingOf`). */
type Biller = { id: string; billingOf?: (models: (string | null)[]) => Promise<Billing | undefined> };

/**
 * How each agent that can say bills, from the models it ran this week, else the ones ion is set to run on it (null:
 * its default): asked of the agent (opencode's own prices). Unknown is null, never free (re-review, 2026-11-22: Free
 * followed ion's default model even after a paid one ran). Agents that can't say keep their sign-in's.
 */
export async function billings(
  agents: Biller[],
  ran: Record<string, string[]>,
  configured: (harness: string) => (string | null)[],
): Promise<Record<string, Billing | null>> {
  const out: Record<string, Billing | null> = {};
  await Promise.all(
    agents.map(async (a) => {
      if (!a.billingOf) return;
      const models = ran[a.id]?.length ? ran[a.id]! : configured(a.id);
      out[a.id] = (await a.billingOf(models).catch(() => undefined)) ?? null;
    }),
  );
  return out;
}

/** The models ion is set to run on an agent: its default (null), ion's quick, deep and judge models, projects'. */
export function configuredModels(
  c: {
    ion: { quick?: string; deep?: string };
    access: { judge?: string };
    projects: { harness?: string; model?: string }[];
  },
  harness: string,
): (string | null)[] {
  const set = [c.ion.quick, c.ion.deep, c.access.judge].filter((spec): spec is string => !!spec);
  const specs = set.map((spec) => spec.split(/:(.*)/));
  const fromSpecs = specs.filter(([h]) => h === harness).map(([, m]) => m || null);
  const fromProjects = c.projects.filter((p) => p.harness === harness).map((p) => p.model ?? null);
  return [null, ...fromSpecs, ...fromProjects];
}
