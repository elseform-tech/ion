import { loadUserConfig, type UserConfig } from "@ion/config";
import { clockOf, type EffortLevel as Effort, type HarnessInfo } from "@ion/schema";
import {
  agentLabel,
  agentOrder,
  byPreference,
  brainModel,
  byStrength,
  defaultAgent,
  getHarness,
  nextInOrder,
  notAvoided,
  savingClaude,
} from "../adapters/registry.js";
import { noAgentLine } from "../runs/agent-steps.js";
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
  /** Nothing is said in the log (a read of Settings). */
  quiet?: true;
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
 * With no agent ready at all, what to do in one line, by your agent order (Plan 21 audit, 2026-11-23: ion chief said
 * "I couldn't reach my agent; try again" with none installed, and trying again couldn't help); null otherwise.
 */
export async function noneReady(d: BrainDeps): Promise<string | null> {
  const all = (await d.agents?.().catch(() => [])) ?? [];
  const ids = byPreference(
    all.map((h) => h.id),
    orderOf(d),
  );
  return noAgentLine(ids.map((id) => all.find((h) => h.id === id)!));
}

/**
 * The agent a chat an ion starts goes on when Automatic finds none: the project's own, else the one its last chat ran
 * on (while still ready: a key can expire; you set the project's own on purpose), else the first ready in your agent
 * order; never one you avoid unless the project names it.
 */
export async function projectAgent(d: BrainDeps, projectId: string): Promise<string | undefined> {
  const c = loadUserConfig(d.configFile).config;
  const own = c.projects.find((p) => p.id === projectId)?.harness;
  if (own) return own;
  // Never one you avoid (PR #36 final review, 2026-11-24): that takes your click.
  const last = chatsView.lastAgent(d.db, projectId);
  if (last && !c.agents?.[last]?.avoid && (!d.agents || (await isReady(d, last)))) return last;
  return defaultAgent(notAvoided(await readyAgents(d.agents), c), null, orderOf(d));
}

/** This agent can start with its web off. */
const webOff = (id: string) => !!getHarness(id)?.adapter.noWeb;

/**
 * ion's dream (the user, 2026-11-24): ions' brain (your pick, else the strongest) at Medium, on an agent that can turn
 * its web off; when the brain's can't, the next strongest that can, said once in the log. With none that can, the
 * brain's own (its turn says it was skipped).
 */
async function dreamWithBrain(d: BrainDeps, quick: string, effort: Effort): Promise<IonBrain | null> {
  const [set, ...rest] = quick.split(":");
  const own = set ? { harness: set, model: rest.join(":") || null, effort } : null;
  if (own && webOff(own.harness) && (await isReady(d, own.harness)) && !isLimited(d, own.harness)) return own;
  const top = own ?? (await nextBrain(d, "chief", [], { effort, quiet: true }));
  if (top && webOff(top.harness)) return top;
  const other = await strongest(d, [], { ok: webOff, quiet: true });
  if (!other) return top;
  if (top && !d.quiet) {
    const line = `Tidy memory: ${agentLabel(top.harness)} can't turn its web off; it runs on ${agentLabel(other)}`;
    if (!said.has(line)) console.warn(line);
    said.add(line);
  }
  return { harness: other, model: brainModel(other), effort };
}

/** ion's dream on the [memory] dreamAgent an older config set (else the first ready one that can turn its web off). */
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
async function strongest(
  d: BrainDeps,
  not: string[],
  { own, quiet, ok }: { own?: string; quiet?: true; ok?: (id: string) => boolean },
): Promise<string | null> {
  const all = byStrength(await readyAgents(d.agents)).filter(ok ?? (() => true));
  const ready = all.filter((id) => !not.includes(id));
  const marks = usageView.agents(d.db, new Date());
  const open = ready.find((id) => !marks[id]?.limitedUntil);
  const passed = open ? ready.slice(0, ready.indexOf(open)) : [];
  if (open && passed.length && !quiet && !d.quiet) {
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

const EFFORT_RANK: Effort[] = ["low", "medium", "high", "max"];
/** The lower of two efforts. */
const lower = (a: Effort, b: Effort): Effort => (EFFORT_RANK.indexOf(a) <= EFFORT_RANK.indexOf(b) ? a : b);

/**
 * How hard ion's brain thinks (PR #36 re-review, the user, 2026-11-23): your effort, else High, for your messages; a
 * routine turn nobody asked for (a project ion's report when its chat ends) at the lower of yours and Medium.
 */
export function brainEffort(mine: Effort | undefined, routine?: boolean): Effort {
  return routine ? lower(mine ?? "medium", "medium") : (mine ?? BRAIN_EFFORT);
}

/**
 * An ion's agent, model and effort, or null when it has no agent ready (the user, 2026-11-23: an ion's brain is
 * better than its workers'). ion chief and every project's ion think with ion's brain: [ion] quick ("<agent>[:<model>]")
 * when you picked it in Settings → Agents, else the strongest model you're signed in to; a project's agent, model and
 * effort are only for the chats its ion starts (PR #36 re-review). One that isn't ready or is limited gives way to the
 * next strongest. ion's dream: [memory] dreamAgent from an older config, else ion's brain at Medium on an agent that
 * can turn its web off.
 */
export async function ionBrain(
  d: BrainDeps,
  ionId: string,
  o: { routine?: boolean } = {},
): Promise<IonBrain | null> {
  const c = loadUserConfig(d.configFile).config;
  const ion = c.ion;
  if (ionId === DREAM_ION)
    return c.memory.dreamAgent
      ? dreamOn(d, c.memory.dreamAgent, ion.quickEffort ?? null)
      : dreamWithBrain(d, ion.quick ?? "", brainEffort(ion.quickEffort, true));
  return chiefBrain(d, ion.quick ?? "", brainEffort(ion.quickEffort, o.routine));
}

/** ion's brain: [ion] quick while it's ready and not limited, else the strongest (saying it went past a limit). */
async function chiefBrain(d: BrainDeps, quick: string, effort: Effort): Promise<IonBrain | null> {
  if (!quick) return nextBrain(d, "chief", [], { effort });
  const [set, ...rest] = quick.split(":");
  const ready = await isReady(d, set!);
  if (ready && !isLimited(d, set!)) return { harness: set!, model: rest.join(":") || null, effort };
  const own = ready ? set : undefined;
  const next = await pastLimited(nextBrain(d, "chief", [set!], { effort, ...(own ? { own } : {}) }), own);
  return next?.harness === set ? { harness: set!, model: rest.join(":") || null, effort } : next;
}

/** The next brain, saying it went past this limited agent (when one was, and it went on another). */
async function pastLimited(next: Promise<IonBrain | null>, limited?: string): Promise<IonBrain | null> {
  const b = await next;
  return b && limited && b.harness !== limited ? { ...b, skipped: [limited] } : b;
}

/**
 * The strongest ready agent but these, for ion's brain when you picked none or yours isn't ready or failed: on its
 * strongest model, at `effort` (default: yours, else High); an explicit dream agent's fallback goes along your agent
 * order instead. `quiet`:
 * nothing said in the log (a read of Settings). Null when none is left.
 */
export async function nextBrain(
  d: BrainDeps,
  ionId: string,
  not: string[],
  o: { own?: string; effort?: Effort; quiet?: true } = {},
): Promise<IonBrain | null> {
  const c = loadUserConfig(d.configFile).config;
  if (ionId === DREAM_ION) {
    const harness = await pick(d, { not, ...(o.own ? { own: o.own } : {}) });
    return harness ? { harness, model: null, effort: c.ion.quickEffort ?? null } : null;
  }
  const harness = await strongest(d, not, o);
  if (!harness) return null;
  return { harness, model: brainModel(harness), effort: o.effort ?? brainEffort(c.ion.quickEffort) };
}

/**
 * The strongest model you're signed in to and the effort ion's brain thinks at on it (yours, else High), as Settings
 * names it whether or not you picked another (the user, 2026-11-23); null when no agent is ready.
 */
export async function strongestBrain(
  d: BrainDeps,
): Promise<{ agent: string; model: string | null; effort: Effort } | null> {
  const b = await nextBrain(d, "chief", [], { quiet: true });
  return b ? { agent: b.harness, model: b.model, effort: b.effort ?? BRAIN_EFFORT } : null;
}

/** An agent, model and effort for a chat an ion starts; no harness: Automatic picks it. */
export type ChatsPick = { harness?: string; model?: string; effort?: Effort };

/** "<agent>[:<model>]" as a pick. */
const specPick = (spec: string, effort?: Effort): ChatsPick => {
  const [harness, ...rest] = spec.split(":");
  const model = rest.join(":");
  return { harness: harness!, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
};

/**
 * What a chat an ion starts runs on (the user, 2026-11-24): what you asked for that chat through the ion, else the
 * project's own (its page → More), else "Chats ions start run on" ([ion] chats); none: Automatic picks the agent.
 */
export function chatsPick(c: UserConfig, projectId: string, asked: ChatsPick = {}): ChatsPick {
  if (asked.harness) return asked;
  const p = c.projects.find((x) => x.id === projectId);
  if (p?.harness)
    return {
      harness: p.harness,
      ...(p.model ? { model: p.model } : {}),
      ...(p.effort ? { effort: p.effort } : {}),
    };
  if (c.ion.chats) return specPick(c.ion.chats, c.ion.chatsEffort);
  const effort = asked.effort ?? p?.effort;
  return effort ? { effort } : {};
}
