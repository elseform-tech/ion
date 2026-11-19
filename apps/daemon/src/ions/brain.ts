import { loadUserConfig } from "@ion/config";
import type { EffortLevel as Effort, HarnessInfo } from "@ion/schema";
import { defaultAgent } from "../adapters/registry.js";
import type { Db } from "../store/index.js";
import { chatsView } from "../views/chats.js";

/** Where an ion's agent is picked from: your config, the chats, and the agents ion can use right now. */
export type BrainDeps = { configFile: string; db: Db; agents?: () => Promise<HarnessInfo[]> };

/** The agents installed and signed in. */
async function readyAgents(agents?: () => Promise<HarnessInfo[]>): Promise<string[]> {
  const all = (await agents?.().catch(() => [])) ?? [];
  return all.filter((h) => h.installed && h.signedIn).map((h) => h.id);
}

/**
 * A project's agent: its own, else the one its last chat ran on (while still ready: a key can expire; you set the
 * project's own on purpose), else the first ready (opencode, Grok, Codex, Claude).
 */
export async function projectAgent(d: BrainDeps, projectId: string): Promise<string | undefined> {
  const own = loadUserConfig(d.configFile).config.projects.find((p) => p.id === projectId)?.harness;
  if (own) return own;
  const ok = await readyAgents(d.agents);
  const last = chatsView.lastAgent(d.db, projectId);
  if (last && (!d.agents || ok.includes(last))) return last;
  return defaultAgent(ok, null);
}

/**
 * The project's model and effort (Settings). Effort always; the model on the agent it was picked for: the
 * project's own, or (none set) the one Settings showed, which is the one `projectAgent` picks.
 */
export function brainOf(
  configFile: string,
  projectId: string,
  harness: string | undefined,
): { model?: string; effort?: Effort } {
  const p = loadUserConfig(configFile).config.projects.find((x) => x.id === projectId);
  if (!p) return {};
  const model = p.model && (!p.harness || p.harness === harness) ? p.model : undefined;
  return { ...(model ? { model } : {}), ...(p.effort ? { effort: p.effort } : {}) };
}

/** What an ion thinks on: its agent, the model on it (null: the agent's own) and the effort (null: the agent's). */
export type IonBrain = { harness: string; model: string | null; effort: Effort | null };

/**
 * An ion's agent, model and effort, or null when it has no agent ready. ion chief: [ion] quick ("<agent>[:<model>]")
 * while that agent is ready, else the first ready on its default model. A project's ion: the project's agent, model
 * and effort, as its threads get them. Effort falls back to [ion] quickEffort.
 */
export async function ionBrain(d: BrainDeps, ionId: string): Promise<IonBrain | null> {
  const ion = loadUserConfig(d.configFile).config.ion;
  const ok = await readyAgents(d.agents);
  const quickEffort = ion.quickEffort ?? null;
  if (ionId === "chief") {
    const [set, ...rest] = ion.quick.split(":");
    if (ok.includes(set!)) return { harness: set!, model: rest.join(":") || null, effort: quickEffort };
    const first = defaultAgent(ok, null);
    return first ? { harness: first, model: null, effort: quickEffort } : null;
  }
  const harness = await projectAgent(d, ionId);
  if (!harness || !ok.includes(harness)) return null;
  const b = brainOf(d.configFile, ionId, harness);
  return { harness, model: b.model ?? null, effort: b.effort ?? quickEffort };
}
