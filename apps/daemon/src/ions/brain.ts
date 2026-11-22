import { loadUserConfig } from "@ion/config";
import type { EffortLevel as Effort, HarnessInfo } from "@ion/schema";
import { defaultAgent, getHarness } from "../adapters/registry.js";
import { DREAM_ION } from "../memory/dream-rules.js";
import type { Db } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { usageView } from "../views/usage.js";

/** Where an ion's agent is picked from: your config, the chats, and the agents ion can use right now. */
export type BrainDeps = {
  configFile: string;
  db: Db;
  agents?: () => Promise<HarnessInfo[]>;
  /** One agent (its CLI asked alone): checking a chosen agent never waits on every other's. */
  agent?: (id: string) => Promise<HarnessInfo | undefined>;
};

/** Whether this one agent is ready: asked alone when ion can, else read from the list. */
async function isReady(d: BrainDeps, id: string): Promise<boolean> {
  if (d.agent) {
    const h = await d.agent(id).catch(() => undefined);
    return !!h && h.installed && h.signedIn;
  }
  return (await readyAgents(d.agents)).includes(id);
}

/** The agents installed and signed in. */
async function readyAgents(agents?: () => Promise<HarnessInfo[]>): Promise<string[]> {
  const all = (await agents?.().catch(() => [])) ?? [];
  return all.filter((h) => h.installed && h.signedIn).map((h) => h.id);
}

/** Whether the agent is marked limited now (by any chat's run or ion's turn: views/usage.ts). */
const isLimited = (d: BrainDeps, id: string): boolean => !!limitedUntil(d.db, id);

/** Until when the agent is limited (ISO), or null. */
export const limitedUntil = (db: Db, id: string): string | null =>
  usageView.agents(db, new Date())[id]?.limitedUntil ?? null;

/** The ready agents that aren't limited: the ones an ion can go on. */
async function usableAgents(d: BrainDeps): Promise<string[]> {
  return (await readyAgents(d.agents)).filter((id) => !isLimited(d, id));
}

/**
 * A project's agent: its own, else the one its last chat ran on (while still ready: a key can expire; you set the
 * project's own on purpose), else the first ready (opencode, Grok, Codex, Claude).
 */
export async function projectAgent(d: BrainDeps, projectId: string): Promise<string | undefined> {
  const own = loadUserConfig(d.configFile).config.projects.find((p) => p.id === projectId)?.harness;
  if (own) return own;
  const last = chatsView.lastAgent(d.db, projectId);
  if (last && (!d.agents || (await isReady(d, last)))) return last;
  return defaultAgent(await readyAgents(d.agents), null);
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

/** This agent can start with its web off. */
const webOff = (id: string) => !!getHarness(id)?.adapter.noWeb;

/**
 * ion's dream's agent: Settings → Memory's (else ion's quick model's) while it's ready and can turn its web off, else
 * the first ready one that can (task review, 2026-11-22); with none, the chosen one (its turn says it was skipped).
 */
async function dreamBrain(d: BrainDeps, spec: string, effort: IonBrain["effort"]): Promise<IonBrain | null> {
  const [set, ...rest] = spec.split(":");
  const ready = await isReady(d, set!);
  if (ready && webOff(set!)) return { harness: set!, model: rest.join(":") || null, effort };
  const other = defaultAgent((await usableAgents(d)).filter(webOff), null);
  if (other) return { harness: other, model: null, effort };
  return ready ? { harness: set!, model: rest.join(":") || null, effort } : null;
}

/** What an ion thinks on: its agent, the model on it (null: the agent's own) and the effort (null: the agent's). */
export type IonBrain = {
  harness: string;
  model: string | null;
  effort: Effort | null;
  /** Its own agents it went past because they're limited (its reply says so in one line). */
  skipped?: string[];
};

/**
 * An ion's agent, model and effort, or null when it has no agent ready. ion chief (and its dream, on [memory]
 * dreamAgent when set): [ion] quick ("<agent>[:<model>]")
 * while that agent is ready, else the first ready on its default model. A project's ion: the project's agent, model
 * and effort, as its threads get them. Effort falls back to [ion] quickEffort.
 */
export async function ionBrain(d: BrainDeps, ionId: string): Promise<IonBrain | null> {
  const c = loadUserConfig(d.configFile).config;
  const ion = c.ion;
  const quickEffort = ion.quickEffort ?? null;
  if (ionId === DREAM_ION) return dreamBrain(d, c.memory.dreamAgent || ion.quick, quickEffort);
  if (ionId === "chief") return chiefBrain(d, ion.quick, quickEffort);
  // A project's own agent that isn't ready (signed out, gone) or is limited gives way to the next ready one (Plan 19's
  // checks; the user, 2026-11-22).
  const harness = await projectAgent(d, ionId);
  if (!harness || !(await isReady(d, harness))) return nextBrain(d, ionId, harness ? [harness] : []);
  if (isLimited(d, harness)) return pastLimited(nextBrain(d, ionId, [harness]), harness);
  const b = brainOf(d.configFile, ionId, harness);
  return { harness, model: b.model ?? null, effort: b.effort ?? quickEffort };
}

/** ion chief's: [ion] quick while it's ready and not limited, else the next ready one (saying it went past a limit). */
async function chiefBrain(d: BrainDeps, quick: string, effort: Effort | null): Promise<IonBrain | null> {
  const [set, ...rest] = quick.split(":");
  const ready = await isReady(d, set!);
  if (ready && !isLimited(d, set!)) return { harness: set!, model: rest.join(":") || null, effort };
  return pastLimited(nextBrain(d, "chief", [set!]), ready ? set : undefined);
}

/** The next brain, saying it went past this limited agent (when one was). */
async function pastLimited(next: Promise<IonBrain | null>, limited?: string): Promise<IonBrain | null> {
  const b = await next;
  return b && limited ? { ...b, skipped: [limited] } : b;
}

/**
 * The first ready agent but these (opencode, Grok, Codex, Claude), for an ion whose own agent isn't ready or failed;
 * on its default model (a project's own model only on the agent it was set for), or null when none is left.
 */
export async function nextBrain(d: BrainDeps, ionId: string, not: string[]): Promise<IonBrain | null> {
  const harness = defaultAgent(
    (await usableAgents(d)).filter((id) => !not.includes(id)),
    null,
  );
  if (!harness) return null;
  const quickEffort = loadUserConfig(d.configFile).config.ion.quickEffort ?? null;
  const b = ionId === "chief" ? {} : brainOf(d.configFile, ionId, harness);
  return { harness, model: b.model ?? null, effort: b.effort ?? quickEffort };
}
