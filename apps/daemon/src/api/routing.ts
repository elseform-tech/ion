import { loadUserConfig, type UserConfig } from "@ion/config";
import { type Candidate, pickAgent } from "@ion/policy";
import type { AgentUsage, EffortLevel, HarnessInfo } from "@ion/schema";
import { agentOrder, getHarness, listedHarnessIds } from "../adapters/registry.js";
import type { Db } from "../store/index.js";
import { usageView } from "../views/usage.js";
import { agentUsages, billings, configuredModels } from "./usage.js";

/** Your agent order (Settings → Agents), every agent ion knows: handoff targets, routing, an ion's chats. */
export const orderIn = (configFile: string): string[] =>
  agentOrder(loadUserConfig(configFile).config.routing.order);

/**
 * Each ready agent's usage, as Settings → Agents shows it: how it bills (from the models it ran, else its sign-in;
 * unknown stays null), its windows and its limit.
 */
export async function usageNow(
  d: { db: Db; configFile: string },
  known: HarnessInfo[],
): Promise<AgentUsage[]> {
  const listed = listedHarnessIds();
  const infos = known.filter((h) => listed.includes(h.id) && h.installed && h.signedIn);
  const rows = usageView.agents(d.db, new Date());
  const c = loadUserConfig(d.configFile).config;
  const ran = Object.fromEntries(Object.entries(rows).map(([id, r]) => [id, r.models]));
  const agents = infos.map((h) => getHarness(h.id)?.adapter).filter((a) => !!a);
  return agentUsages(infos, rows, await billings(agents, ran, (h) => configuredModels(c, h)));
}

/** Deep work: what needs ion's deep model (its agent is kept for it otherwise). */
const isDeep = (effort: EffortLevel | undefined) => effort === "max";

/**
 * Pick by usage (the user, 2026-11-22: off at first): the agent a new chat you picked none for goes on, and why in one
 * line; null when it's off or no agent is free (ion's usual default applies). "Verify, don't guess": headroom only
 * from the windows an agent reports; one limited only by ion's guess is tried, last.
 */
export function routeBy(
  c: UserConfig,
  usage: AgentUsage[],
  o: { db: Db; projectId?: string; effort?: EffortLevel; now?: Date },
): { harness: string; reason: string } | null {
  if (!c.routing.byUsage) return null;
  const now = o.now ?? new Date();
  const rows = usageView.agents(o.db, now);
  const candidates: Candidate[] = usage.map((u) => ({
    ...{ id: u.harness, label: u.label, billing: u.billing, windows: u.windows },
    ...{ limitedUntil: u.limitedUntil, ...(rows[u.harness]?.limitGuessed ? { limitGuessed: true } : {}) },
  }));
  const project = c.projects.find((p) => p.id === o.projectId)?.harness;
  const deepAgent = c.ion.deep.split(":")[0];
  const task = { order: agentOrder(c.routing.order), now, deep: isDeep(o.effort) };
  const r = pickAgent(candidates, {
    ...task,
    ...(project ? { project } : {}),
    ...(deepAgent ? { deepAgent } : {}),
  });
  return r.agent && r.reason ? { harness: r.agent, reason: r.reason } : null;
}

/** Pick by usage for a new chat, from the agents ion knows now (read only when it's on). */
export async function routed(
  d: { db: Db; configFile: string },
  known: () => Promise<HarnessInfo[]>,
  o: { projectId?: string; effort?: EffortLevel },
): Promise<{ harness: string; reason: string } | null> {
  const c = loadUserConfig(d.configFile).config;
  if (!c.routing.byUsage) return null;
  return routeBy(c, await usageNow(d, await known()), { db: d.db, ...o });
}
