import { loadUserConfig } from "@ion/config";
import { clockOf, type EffortLevel as Effort, type HarnessInfo } from "@ion/schema";
import {
  agentLabel,
  agentOrder,
  brainModel,
  byStrength,
  defaultAgent,
  getHarness,
  nextInOrder,
  savingClaude,
} from "../adapters/registry.js";
import { DREAM_ION } from "../memory/dream-rules.js";
import type { Db } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { usageView } from "../views/usage.js";
import { limitedLine } from "./fallback.js";

/** Where an ion's agent is picked from: your config, the chats, and the agents ion can use right now. */
export type BrainDeps = {
  configFile: string;
  db: Db;
  agents?: () => Promise<HarnessInfo[]>;
  /** One agent (its CLI asked alone): checking a chosen agent never waits on every other's. */
  agent?: (id: string) => Promise<HarnessInfo | undefined>;
};

/** Your agent order (Settings → Agents). */
const orderOf = (d: BrainDeps) => agentOrder(loadUserConfig(d.configFile).config.routing.order);

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

/**
 * The agent an ion goes on among the ready ones `ok` lets through, but `not`: the first in your order that isn't
 * limited; with none, one whose limit is only ion's guess (no stated reset: it may be free again, and one turn tells;
 * `own` first), never one with a stated reset (review, 2026-11-22). Claude Code only when it's first in your order or
 * the only one ready (Plan 21 audit, 2026-11-23).
 */
async function pick(d: BrainDeps, o: { not: string[]; own?: string; ok?: (id: string) => boolean }) {
  const signedIn = await readyAgents(d.agents);
  const ready = signedIn.filter(o.ok ?? (() => true));
  const marks = usageView.agents(d.db, new Date());
  const order = orderOf(d);
  const limited = (id: string) => !!marks[id]?.limitedUntil;
  const open = nextInOrder({ order, ready, limited, not: o.not, signedIn });
  if (open) return open;
  const guessed = ready.filter((id) => marks[id]?.limitGuessed);
  if (o.own && guessed.includes(o.own)) return o.own;
  const others = savingClaude(
    guessed.filter((id) => !o.not.includes(id)),
    order,
    signedIn,
  );
  return defaultAgent(others, null, order) ?? null;
}

/**
 * With no agent an ion can go on because every ready one is limited with a stated reset: which frees up first, in a
 * few words ("Claude Code is limited until 16:00"); null otherwise.
 */
export async function allLimited(d: BrainDeps): Promise<string | null> {
  const ready = await readyAgents(d.agents);
  const marks = usageView.agents(d.db, new Date());
  if (!ready.length || ready.some((id) => !marks[id]?.limitedUntil || marks[id]?.limitGuessed)) return null;
  const first = ready.reduce((a, b) => (marks[b]!.limitedUntil! < marks[a]!.limitedUntil! ? b : a));
  return limitedLine(getHarness(first)?.label ?? first, clockOf(marks[first]!.limitedUntil!, new Date()));
}

/**
 * A project's agent: its own, else the one its last chat ran on (while still ready: a key can expire; you set the
 * project's own on purpose), else the first ready in your agent order.
 */
export async function projectAgent(d: BrainDeps, projectId: string): Promise<string | undefined> {
  const own = loadUserConfig(d.configFile).config.projects.find((p) => p.id === projectId)?.harness;
  if (own) return own;
  const last = chatsView.lastAgent(d.db, projectId);
  if (last && (!d.agents || (await isReady(d, last)))) return last;
  return defaultAgent(await readyAgents(d.agents), null, orderOf(d));
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
async function dreamOn(d: BrainDeps, spec: string, effort: IonBrain["effort"]): Promise<IonBrain | null> {
  if (spec) return dreamBrain(d, spec, effort);
  const first = await pick(d, { not: [], ok: webOff });
  return first ? { harness: first, model: null, effort } : null;
}

/** The dream's chosen agent while it can (see dreamOn). */
async function dreamBrain(d: BrainDeps, spec: string, effort: IonBrain["effort"]): Promise<IonBrain | null> {
  const [set, ...rest] = spec.split(":");
  const ready = await isReady(d, set!);
  const own = { harness: set!, model: rest.join(":") || null, effort };
  if (ready && webOff(set!) && !isLimited(d, set!)) return own;
  const other = await pick(d, { not: [], ok: webOff, ...(ready ? { own: set! } : {}) });
  if (other) return other === set ? own : { harness: other, model: null, effort };
  // No agent that can turn its web off: the chosen one, unless it's limited (its turn says it was skipped).
  return ready && !webOff(set!) && !isLimited(d, set!) ? own : null;
}

/** What an ion thinks on: its agent, the model on it (null: the agent's own) and the effort (null: the agent's). */
export type IonBrain = {
  harness: string;
  model: string | null;
  effort: Effort | null;
  /** Its own agents it went past because they're limited (its reply says so in one line). */
  skipped?: string[];
};

/** ion's brain's effort when you picked none (the user, 2026-11-23: the strongest model, at High). */
const BRAIN_EFFORT: Effort = "high";

/** What ion's brain said it went past, once each (the daemon's log). */
const said = new Set<string>();

/**
 * The strongest agent ready but these (the rank each adapter gives its strongest model; the user, 2026-11-23), not
 * limited; with none, one whose limit is only ion's guess (`own` first). Going past a stronger one that's limited is
 * said once in the log.
 */
async function strongest(d: BrainDeps, not: string[], own?: string): Promise<string | null> {
  const all = byStrength(await readyAgents(d.agents));
  const ready = all.filter((id) => !not.includes(id));
  const marks = usageView.agents(d.db, new Date());
  const open = ready.find((id) => !marks[id]?.limitedUntil);
  const passed = open ? ready.slice(0, ready.indexOf(open)) : [];
  if (open && passed.length) {
    const line = `ion's brain: ${agentLabel(passed[0]!)} is limited; it thinks on ${agentLabel(open)}`;
    if (!said.has(line)) console.warn(line);
    said.add(line);
  }
  if (open) return open;
  // Limited only by ion's guess: `own` first (one turn tells), else the strongest such, never one you passed over.
  const guessed = all.filter((id) => marks[id]?.limitGuessed);
  if (own && guessed.includes(own)) return own;
  return guessed.find((id) => !not.includes(id)) ?? null;
}

/**
 * An ion's agent, model and effort, or null when it has no agent ready (the user, 2026-11-23: an ion's brain is
 * better than its workers'). ion chief: [ion] quick ("<agent>[:<model>]") and quickEffort when you picked them, else
 * the strongest model you're signed in to, at High. A project's ion: the project's own agent, model and effort, else
 * the same strongest. One that isn't ready or is limited gives way to the next strongest. ion's dream: [memory]
 * dreamAgent, else [ion] quick, else your agent order (low-decision work).
 */
export async function ionBrain(d: BrainDeps, ionId: string): Promise<IonBrain | null> {
  const c = loadUserConfig(d.configFile).config;
  const ion = c.ion;
  if (ionId === DREAM_ION) return dreamOn(d, c.memory.dreamAgent || ion.quick || "", ion.quickEffort ?? null);
  const effort = ion.quickEffort ?? BRAIN_EFFORT;
  if (ionId === "chief") return chiefBrain(d, ion.quick ?? "", effort);
  return projectBrain(d, ionId, c.projects.find((p) => p.id === ionId)?.harness, effort);
}

/**
 * A project's ion: its own agent, model and effort; one that isn't ready (signed out, gone) or is limited gives way to
 * the next strongest (Plan 19's checks; the user, 2026-11-22 and 2026-11-23), as does a project with none.
 */
async function projectBrain(
  d: BrainDeps,
  ionId: string,
  harness: string | undefined,
  effort: Effort,
): Promise<IonBrain | null> {
  if (!harness || !(await isReady(d, harness))) return nextBrain(d, ionId, harness ? [harness] : []);
  if (isLimited(d, harness)) {
    const next = await pastLimited(nextBrain(d, ionId, [harness], harness), harness);
    if (next?.harness !== harness) return next;
  }
  const b = brainOf(d.configFile, ionId, harness);
  return { harness, model: b.model ?? null, effort: b.effort ?? effort };
}

/** ion chief's: [ion] quick while it's ready and not limited, else the strongest (saying it went past a limit). */
async function chiefBrain(d: BrainDeps, quick: string, effort: Effort): Promise<IonBrain | null> {
  if (!quick) return nextBrain(d, "chief", []);
  const [set, ...rest] = quick.split(":");
  const ready = await isReady(d, set!);
  if (ready && !isLimited(d, set!)) return { harness: set!, model: rest.join(":") || null, effort };
  const next = await pastLimited(
    nextBrain(d, "chief", [set!], ready ? set : undefined),
    ready ? set : undefined,
  );
  return next?.harness === set ? { harness: set!, model: rest.join(":") || null, effort } : next;
}

/** The next brain, saying it went past this limited agent (when one was, and it went on another). */
async function pastLimited(next: Promise<IonBrain | null>, limited?: string): Promise<IonBrain | null> {
  const b = await next;
  return b && limited && b.harness !== limited ? { ...b, skipped: [limited] } : b;
}

/**
 * The strongest ready agent but these, for an ion with none of its own or whose own isn't ready or failed: on its
 * strongest model (a project's own model only on the agent it was set for), at your effort, else High; ion's dream
 * goes along your agent order instead. Null when none is left.
 */
export async function nextBrain(
  d: BrainDeps,
  ionId: string,
  not: string[],
  own?: string,
): Promise<IonBrain | null> {
  const c = loadUserConfig(d.configFile).config;
  if (ionId === DREAM_ION) {
    const harness = await pick(d, { not, ...(own ? { own } : {}) });
    return harness ? { harness, model: null, effort: c.ion.quickEffort ?? null } : null;
  }
  const harness = await strongest(d, not, own);
  if (!harness) return null;
  const b = ionId === "chief" ? {} : brainOf(d.configFile, ionId, harness);
  return {
    harness,
    model: b.model ?? brainModel(harness),
    effort: b.effort ?? c.ion.quickEffort ?? BRAIN_EFFORT,
  };
}

/**
 * The strongest model you're signed in to and the effort ion's brain thinks at on it (yours, else High), as Settings
 * names it whether or not you picked another (the user, 2026-11-23); null when no agent is ready.
 */
export async function strongestBrain(
  d: BrainDeps,
): Promise<{ agent: string; model: string | null; effort: Effort } | null> {
  const b = await nextBrain(d, "chief", []);
  return b ? { agent: b.harness, model: b.model, effort: b.effort ?? BRAIN_EFFORT } : null;
}
