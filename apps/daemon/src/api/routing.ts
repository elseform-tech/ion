import { DEFAULT_PROJECT, loadUserConfig, type UserConfig } from "@ion/config";
import { type Candidate, pickAgent } from "@ion/policy";
import type { AgentUsage, EffortLevel, HarnessInfo, TaskEstimate } from "@ion/schema";
import { agentOrder, byStrength, getHarness, listedHarnessIds } from "../adapters/registry.js";
import type { Db } from "../store/index.js";
import { estimateOf } from "../views/estimate.js";
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

/** What the request usually takes on each agent, from the project's past chats (none for an agent with too few). */
function estimates(db: Db, usage: AgentUsage[], q: { projectId: string; text?: string }) {
  const out: Record<string, TaskEstimate> = {};
  if (!q.text?.trim()) return out;
  for (const u of usage) {
    const e = estimateOf(db, { projectId: q.projectId, harness: u.harness, text: q.text }, u);
    if (e) out[u.harness] = e;
  }
  return out;
}

/**
 * Pick by usage (the user, 2026-11-22: off at first): the agent a new chat you picked none for goes on, and why in one
 * line; null when it's off or no agent is free (ion's usual default applies). "Verify, don't guess": headroom only
 * from the windows an agent reports; one limited only by ion's guess is tried, last. `estimate`: what the request
 * usually takes on the agent picked (worked out once, for the brain pill's hover too).
 */
export function routeBy(
  c: UserConfig,
  usage: AgentUsage[],
  o: { db: Db; projectId?: string; effort?: EffortLevel; text?: string; now?: Date; thread?: boolean },
): { harness: string; reason: string; estimate?: TaskEstimate } | null {
  if (!c.routing.byUsage) return null;
  const now = o.now ?? new Date();
  const rows = usageView.agents(o.db, now);
  const candidates: Candidate[] = usage.map((u) => ({
    ...{ id: u.harness, label: u.label, billing: u.billing, windows: u.windows },
    ...{ limitedUntil: u.limitedUntil, ...(rows[u.harness]?.limitGuessed ? { limitGuessed: true } : {}) },
  }));
  // The project's own agent is a fit only for its ion's threads; your own chats follow your order (the user, 2026-11-23).
  const project = o.thread ? c.projects.find((p) => p.id === o.projectId)?.harness : undefined;
  // Yours, else the strongest agent ready (the user, 2026-11-23: ion's brain is the strongest you're signed in to).
  const deepAgent = c.ion.deep?.split(":")[0] || byStrength(usage.map((u) => u.harness))[0];
  // A task that usually takes more of an agent's window than it has left goes on another (the user, 2026-11-22).
  const estimate = estimates(o.db, usage, {
    projectId: o.projectId ?? DEFAULT_PROJECT,
    ...(o.text ? { text: o.text } : {}),
  });
  const task = { order: agentOrder(c.routing.order), now, deep: isDeep(o.effort), estimate };
  const r = pickAgent(candidates, {
    ...task,
    ...(project ? { project } : {}),
    ...(deepAgent ? { deepAgent } : {}),
  });
  if (!r.agent || !r.reason) return null;
  const mine = estimate[r.agent];
  return { harness: r.agent, reason: r.reason, ...(mine ? { estimate: mine } : {}) };
}

/** Pick by usage for a new chat, from the agents ion knows now (read only when it's on). */
export async function routed(
  d: { db: Db; configFile: string },
  known: () => Promise<HarnessInfo[]>,
  o: { projectId?: string; effort?: EffortLevel; text?: string; thread?: boolean },
): Promise<{ harness: string; reason: string } | null> {
  const c = loadUserConfig(d.configFile).config;
  if (!c.routing.byUsage) return null;
  return routeBy(c, await usageNow(d, await known()), { db: d.db, ...o });
}
