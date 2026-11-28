import type { Billing, TaskEstimate, UsageWindow } from "@ion/schema";

/** One agent signed in now: how it bills, the windows it reports (none: learned from errors), its limit mark. */
export type Candidate = {
  id: string;
  label: string;
  billing: Billing | null;
  windows: UsageWindow[];
  /** Until when it's limited (ISO), or null. */
  limitedUntil: string | null;
  /** The limit didn't say when it resets: ion's guess, so it may be free again (it's tried, last). */
  limitGuessed?: boolean;
};

/** What the chat is: your agent order, and what fits it. */
export type Task = {
  /** Your agent order (Settings → Agents), best first; agents not in it come after. */
  order: string[];
  now: Date;
  /** The agent you picked: it always wins. */
  picked?: string;
  /** The project's own agent. */
  project?: string;
  /** The work needs ion's deep model. */
  deep?: boolean;
  /** ion's deep model's agent: kept for deep work. */
  deepAgent?: string;
  /** What this task usually takes on each agent, from your past chats (none: too few to say). */
  estimate?: Record<string, TaskEstimate>;
  /** Agents you marked "Avoid unless I ask" (the user, 2026-11-24): never picked here. */
  avoid?: string[];
  /** Agents that come after every other (Claude Code: saved), unless one is all that's left. */
  last?: string[];
};

/** The agent, and why in one line ("On Codex — Claude Code is near its limit"); null when you picked it. */
export type Pick = { agent: string | null; reason: string | null };

/** A window this full is near its end: another agent goes first. */
const NEAR_PERCENT = 80;

const isNear = (c: Candidate, now: Date) =>
  c.windows.some(
    (w) => w.usedPercent >= NEAR_PERCENT && (w.resetsAt === null || Date.parse(w.resetsAt) > now.getTime()),
  );
/** The task usually takes more of a window than the agent has left (the high end of its estimate). */
const tooBig = (c: Candidate, t: Task) => {
  const e = t.estimate?.[c.id];
  if (e?.unit !== "percent") return false;
  const w = c.windows.find(
    (x) => x.name === e.window && (x.resetsAt === null || Date.parse(x.resetsAt) > t.now.getTime()),
  );
  return !!w && e.high > 100 - w.usedPercent;
};
const limited = (c: Candidate) => !!c.limitedUntil && !c.limitGuessed;
const fits = (c: Candidate, t: Task) => (t.deep && c.id === t.deepAgent) || c.id === t.project;
/** The deep model's agent is kept for deep work, unless you put it first in your order (or it's the project's). */
const kept = (c: Candidate, t: Task) =>
  !t.deep && c.id === t.deepAgent && c.id !== t.project && t.order[0] !== c.id;

/** Where an agent is in your order (one not in it after all that are). */
const rank = (c: Candidate, t: Task) => {
  const i = t.order.indexOf(c.id);
  return i < 0 ? t.order.length : i;
};

/** What you'd expect first: what fits, then your order. */
const expected = (c: Candidate, t: Task): number[] => [fits(c, t) ? 0 : 1, rank(c, t)];

/**
 * Best first: room left (a guessed limit is tried last; a task that usually takes more than an agent's window has left
 * goes elsewhere), what fits, the deep model's agent kept back, subscription
 * and free before api, then your order.
 */
const weight = (c: Candidate, t: Task): number[] => [
  t.last?.includes(c.id) ? 1 : 0,
  isNear(c, t.now) || c.limitGuessed || tooBig(c, t) ? 1 : 0,
  fits(c, t) ? 0 : 1,
  kept(c, t) ? 1 : 0,
  c.billing === "api" ? 1 : 0,
  rank(c, t),
];

const byWeight = (w: (c: Candidate) => number[]) => (a: Candidate, b: Candidate) => {
  const [x, y] = [w(a), w(b)];
  const i = x.findIndex((v, k) => v !== y[k]);
  return i < 0 ? 0 : x[i]! - y[i]!;
};

/** Why `top` (the one you'd expect) wasn't picked, in a few words. */
function passedOver(top: Candidate, t: Task): string {
  if (limited(top)) return `${top.label} hit its limit`;
  if (isNear(top, t.now)) return `${top.label} is near its limit`;
  if (tooBig(top, t)) return `${top.label} has too little left for this`;
  if (top.limitGuessed) return `${top.label} may still be at its limit`;
  if (kept(top, t)) return `${top.label} is kept for deep work`;
  return `${top.label} is paid per use`;
}

/** Why the agent that was expected anyway fits. */
function fitsBecause(c: Candidate, t: Task): string {
  if (t.deep && c.id === t.deepAgent) return "deep work";
  if (c.id === t.project) return "this project's agent";
  return c.billing === "free" ? "free and enough for this" : "first in your order";
}

/**
 * The agent a chat goes on when you picked none: never a limited one (one limited only by ion's guess is tried after
 * the rest); then one with room in its windows, what fits (the project's agent, ion's deep model's for deep work,
 * which is kept otherwise), your order, and subscription or free before api. With the reason in one line.
 */
export function pickAgent(candidates: Candidate[], t: Task): Pick {
  if (t.picked) return { agent: t.picked, reason: null };
  const open = candidates
    .filter((c) => !limited(c) && !t.avoid?.includes(c.id))
    .sort(byWeight((c) => weight(c, t)));
  const pick = open[0];
  if (!pick) return { agent: null, reason: "No agent is free" };
  const top = [...candidates].sort(byWeight((c) => expected(c, t)))[0]!;
  const why = top.id === pick.id ? fitsBecause(pick, t) : passedOver(top, t);
  return { agent: pick.id, reason: `On ${pick.label} — ${why}` };
}
