import { DEFAULT_PROJECT, loadUserConfig, type UserConfig } from "@ion/config";
import { type Candidate, pickAgent } from "@ion/policy";
import type { AgentUsage, EffortLevel, HarnessInfo, TaskEstimate } from "@ion/schema";
import { agentOrder, defaultAgent, getHarness, listedHarnessIds, notAvoided } from "../adapters/registry.js";
import type { Db } from "../store/index.js";
import { estimateOf } from "../views/estimate.js";
import { usageView } from "../views/usage.js";
import { agentUsages, billings, configuredModels } from "./usage.js";

/** Your agent order (Settings → Agents), every agent ion knows: handoff targets, routing, an ion's chats. */
export const orderIn = (configFile: string): string[] =>
  agentOrder(loadUserConfig(configFile).config.routing.order);

/**
 * The agent a message goes on when you picked none and Automatic found none: `own` (the chat's) while it's ready, else
 * the first ready in your order; never one you avoid (PR #36 final review, 2026-11-24). The send and the estimate
 * before it both ask this (brain-avoid fix review, 2026-11-28). None: undefined.
 */
export function usualAgent(configFile: string, ready: string[], own: string | null): string | undefined {
  const c = loadUserConfig(configFile).config;
  return defaultAgent(notAvoided(ready, c), own && ready.includes(own) ? own : null, orderIn(configFile));
}

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

/** The agent Automatic saves for last (the user's standing rule): picked only when it's all that's left. */
const SAVED = ["claude-code"];

/**
 * Automatic (the user, 2026-11-24: Pick by usage, always on): the agent a chat you (or an ion) picked none for goes
 * on, and why in one line; null when no agent is free (ion's usual default applies). Ready, not limited, with room in
 * its windows ("verify, don't guess": headroom only from the windows an agent reports; one limited only by ion's guess
 * is tried, last), free or subscription before pay-per-use, Claude Code last unless it's the only one, never one you
 * avoid, along "Prefer in this order" when you set one. `estimate`: what the request usually takes on the agent picked.
 */
export function routeBy(
  c: UserConfig,
  usage: AgentUsage[],
  o: { db: Db; projectId?: string; effort?: EffortLevel; text?: string; now?: Date },
): { harness: string; reason: string; estimate?: TaskEstimate } | null {
  const now = o.now ?? new Date();
  const rows = usageView.agents(o.db, now);
  const candidates: Candidate[] = usage.map((u) => ({
    ...{ id: u.harness, label: u.label, billing: u.billing, windows: u.windows },
    ...{ limitedUntil: u.limitedUntil, ...(rows[u.harness]?.limitGuessed ? { limitGuessed: true } : {}) },
  }));
  // A task that usually takes more of an agent's window than it has left goes on another (the user, 2026-11-22).
  const estimate = estimates(o.db, usage, {
    projectId: o.projectId ?? DEFAULT_PROJECT,
    ...(o.text ? { text: o.text } : {}),
  });
  const avoid = Object.entries(c.agents ?? {})
    .filter(([, a]) => a?.avoid)
    .map(([id]) => id);
  const r = pickAgent(candidates, { order: agentOrder(c.routing.order), now, estimate, avoid, last: SAVED });
  if (!r.agent || !r.reason) return null;
  const mine = estimate[r.agent];
  return { harness: r.agent, reason: r.reason, ...(mine ? { estimate: mine } : {}) };
}

/** Automatic for a chat, from the agents ion knows now. */
export async function routed(
  d: { db: Db; configFile: string },
  known: () => Promise<HarnessInfo[]>,
  o: { projectId?: string; effort?: EffortLevel; text?: string; thread?: boolean },
): Promise<{ harness: string; reason: string } | null> {
  const c = loadUserConfig(d.configFile).config;
  return routeBy(c, await usageNow(d, await known()), { db: d.db, ...o });
}
