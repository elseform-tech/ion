import type { EffortLevel } from "./capabilities.js";

/**
 * How an agent bills, from its sign-in: `subscription` (no extra cost until its limit), `api` (paid per token),
 * `free` (no cost, limits opaque). Unknown is null, and never shown as free.
 */
export type Billing = "subscription" | "api" | "free";

/** One coding agent: whether it's ready, its models, what it brings of its own, how it bills. */
export type HarnessInfo = {
  id: string;
  label: string;
  installed: boolean;
  signedIn: boolean;
  /** Its sign-in check didn't answer: not known to be signed in or out. */
  signInUnknown?: true;
  /** From the harness itself when it's signed in; empty otherwise. */
  models: { id: string; label: string }[];
  defaultModel: string | null;
  /** With "Use its own tools" off, it still loads MCP servers, hooks or plugins of its own (no switch for them all). */
  ownTools?: true;
  /** Its own hooks run in ion's chats too (no switch for them). */
  ownHooks?: true;
  /** What "Use its own tools" off really turns off, by kind. Absent: all of it. */
  ownOff?: { servers: boolean; skills: boolean; plugins: boolean };
  /** It trusts a project's own tools by its own list. */
  ownTrust?: true;
  /** Its chats run without the OS sandbox here (no sandbox on this computer): ion's folders are only word-guarded. */
  notSandboxed?: true;
  /** How many of its own allow and deny rules (your settings for it) its chats go by: deny wins, in every mode. */
  ownRules?: number;
  /** How often its judge didn't answer (too slow, or failed) in the last 7 days; absent when it always did. */
  judgeMisses?: number;
  /** How its sign-in bills, when known (absent: unknown, never shown as free). */
  billing?: Billing;
  /**
   * How you sign in: its own command; `inApp`, ion runs it and shows its page and code; `clears`, starting it clears
   * the sign-in it has (ion warns first).
   */
  signIn?: { command: string; inApp: boolean; clears?: true };
  /** How you sign out: its own command; `inApp`, ion runs it (after you confirm). */
  signOut?: { command: string; inApp: boolean };
  /** Its sign-in ion started and waits on: the page to open and the code to confirm there, nothing else it printed. */
  signingIn?: LoginPage;
  /** The command that installs it (Plan 21: a beginner without it is told how). */
  install?: string;
};

/** One agent on the first run: ready, or the command that gets it there (install it, or sign in). */
export type AgentStep = {
  id: string;
  label: string;
  /** `checking`: ion is still reading it (a fresh start). */
  state: "ready" | "install" | "signIn" | "checking";
  /** The command to type: its install, or its sign-in. */
  command?: string;
  /** ion can run its sign-in itself (Settings → Agents' Sign in). */
  inApp?: boolean;
};

/**
 * `start.status`: your agents, your own projects (not ion's `default`) and your chats (archived too). `firstRun`: none
 * of either, so the app opens on its first-run screen and bare `ion` prints the first steps.
 */
export type StartStatus = { agents: AgentStep[]; projects: number; chats: number; firstRun: boolean };

/** An agent's sign-in page and the code to confirm there (either may be missing). */
export type LoginPage = { url: string | null; code: string | null };

/** `harness.login`: ion started the agent's own sign-in (its page and code), or the command to type in a terminal. */
export type SignInResult = ({ kind: "started" } & LoginPage) | { kind: "command"; command: string };

/** `harness.logout`: ion ran the agent's own sign-out (and whether it now reads signed in), or the command to type. */
export type SignOutResult = { kind: "done"; signedIn: boolean } | { kind: "command"; command: string };

/** The agents' commands, in the contract's order: the list, and signing in and out (the user, 2026-11-23). */
export const AGENT_COMMANDS = [
  "harnesses.list",
  "start.status",
  "harness.login",
  "harness.logout",
  "harness.cancelLogin",
  "agents.checks",
  "agents.check",
] as const;

/** The coding agents: each one's state, and signing in and out of it from ion (the user, 2026-11-23). */
export type AgentCommands = {
  /** `fresh`: each agent is read again now (Check again), not answered from what ion read a minute ago. */
  "harnesses.list": { args: { fresh?: boolean }; result: HarnessInfo[] };
  /** What a first run needs (Plan 21): each agent's state and its one-line fix, and how much you have in ion. */
  "start.status": { args: { fresh?: boolean }; result: StartStatus };
  /**
   * Starts an agent's own sign-in where it needs no terminal (its page and code), else gives its command. Refused while
   * it's signed in or the agent isn't installed; one whose sign-in clears the one it has (`signIn.clears`) needs
   * `confirm`.
   */
  "harness.login": { args: { id: string; confirm?: boolean }; result: SignInResult };
  /**
   * Runs an agent's own sign-out, which signs it out on this computer, not only in ion: only with `confirm`, and refused
   * while it works in a chat. An agent whose sign-out needs a terminal: its command.
   */
  "harness.logout": { args: { id: string; confirm?: boolean }; result: SignOutResult };
  /** Stops an agent's sign-in ion started (its page is gone; the agent stays signed out). */
  "harness.cancelLogin": { args: { id: string }; result: { ok: true } };
  /**
   * "Check the agents each night" (Plan 21 Task 5): on or off, and the agents that aren't free you pick for it; returns
   * each agent's part in it and the last checks.
   */
  "agents.checks": { args: { nightly?: boolean; pick?: Record<string, boolean> }; result: AgentChecksInfo };
  /** Checks the agents now, as the night would (waits for them), and returns what it found. */
  "agents.check": { args: Record<string, never>; result: AgentChecksInfo };
};

/**
 * One of ion's checks of an agent: it starts, answers, reaches ion's tools, its calls reach ion's gate, signed in.
 * `limited`: its use is used up (not broken: never a failure).
 */
export type AgentCheckItem = { name: string; ok: boolean; note?: string; limited?: true };

/** ion's last check of one agent (`at`: when it ran, ISO; `by`: the night's check, or one you asked for now). */
export type AgentCheckRecord = {
  agent: string;
  label: string;
  at: string;
  by?: "night" | "now";
  checks: AgentCheckItem[];
};

/**
 * One agent in the nightly check: whether it's in (`why`: why not), whether you picked it (one that isn't free is in
 * only then; Claude Code too), and what a night costs it.
 */
export type AgentCheckRow = {
  agent: string;
  label: string;
  included: boolean;
  why: string | null;
  picked: boolean;
  cost: string;
};

/** The nightly check: on or off, going now, when it runs ("01:00–06:00"), each agent's part, and the last checks. */
export type AgentChecksInfo = {
  nightly: boolean;
  running: boolean;
  window: string;
  agents: AgentCheckRow[];
  last: AgentCheckRecord[];
};

/** How many of a check's parts failed (used up isn't failed). */
export const checksFailed = (r: AgentCheckRecord): number => r.checks.filter((c) => !c.ok).length;

/** Its use was used up at the check (not broken): why, in its own words. */
const usedUp = (r: AgentCheckRecord): string | undefined => r.checks.find((c) => c.limited)?.note;

/**
 * When a check ran, in words: "last night" only for the night's check; else "today at 14:05", "yesterday at 09:10",
 * or "on 2026-11-20 at 14:05".
 */
function whenChecked(r: AgentCheckRecord, now: Date): string {
  const at = new Date(r.at);
  const day = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (r.by === "night" && days <= 1) return "last night";
  const clock = `at ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (days === 0) return `today ${clock}`;
  if (days === 1) return `yesterday ${clock}`;
  return `on ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clock}`;
}

/** An agent's line when it failed or was used up, with when ("Grok Build: 2 checks failed · last night"). */
function badLine(r: AgentCheckRecord, now: Date): string | null {
  const n = checksFailed(r);
  const out = usedUp(r);
  if (!n && !out) return null;
  const failed = n === 1 ? "1 check failed" : `${n} checks failed`;
  const what = n ? failed : out!.toLowerCase();
  return `${r.label}: ${what} · ${whenChecked(r, now)}`;
}

/**
 * The checks in a line each: "Checked last night: all fine" (the oldest agent's check when they differ), or one per
 * agent that failed or was used up ("Grok Build: 2 checks failed · today at 14:05"); none before the first check.
 */
export function checkLines(last: AgentCheckRecord[], now: Date): string[] {
  const bad = last.map((r) => badLine(r, now)).filter((l): l is string => l !== null);
  if (bad.length) return bad;
  const oldest = [...last].sort((a, b) => a.at.localeCompare(b.at))[0];
  return oldest ? [`Checked ${whenChecked(oldest, now)}: all fine`] : [];
}

/** One of an agent's rate-limit windows, as it reported it. */
export type UsageWindow = { name: string; usedPercent: number; resetsAt: string | null };

/** What ion knows of one agent's usage: tokens and cost (today, the last 7 days), its windows, its limit. */
export type AgentUsage = {
  harness: string;
  label: string;
  billing: Billing | null;
  today: { tokens: number; costUsd: number };
  week: { tokens: number; costUsd: number };
  /** The windows its last run reported (none: it doesn't report them, or stopped). */
  windows: UsageWindow[];
  /** Until when it's limited (ISO), when it hit its limit; null when it isn't. */
  limitedUntil: string | null;
};

/**
 * What a task usually takes, from similar past chats (median to p90): tokens, its cost for an agent paid per token
 * (`usd`), or its share of one of the agent's windows (`percent`, only from windows it really reports).
 */
export type TaskEstimate =
  | { unit: "tokens" | "usd"; low: number; high: number }
  | { unit: "percent"; low: number; high: number; window: string };

/** Tokens in few figures, with the unit only on the high end when both share it: "40", "120k", "1.2M". */
function tokens(n: number): { n: string; unit: string } {
  // From 999.5k it rounds to a thousand k: "1M", never "1000k".
  if (n >= 999_500) return { n: String(Math.round(n / 100_000) / 10), unit: "M" };
  if (n >= 1000) return { n: String(Math.round(n / 1000)), unit: "k" };
  return { n: String(n), unit: "" };
}

/** Low to high, or one figure when they're the same: "40–120k", "5–10%". */
const span = (low: string, high: string) => (low === high ? high : `${low}–${high}`);

/** Dollars to the cent; a low end under a cent says only the high end ("under $0.05", "under $0.01"). */
function dollars(low: number, high: number): string {
  const usd = (n: number) => "$" + Math.max(0.01, n).toFixed(2);
  return low < 0.01 ? `under ${usd(high)}` : span(usd(low), usd(high));
}

/**
 * What a task usually takes, in words: "usually 40–120k tokens", "usually $0.20–$0.60", "usually 5–10% of 5 h".
 * A share rounds to whole percent, never below 1.
 */
export function estimateText(e: TaskEstimate): string {
  if (e.unit === "usd") return `usually ${dollars(e.low, e.high)}`;
  if (e.unit === "percent") {
    const pct = (n: number) => String(Math.max(1, Math.round(n)));
    return `usually ${span(pct(e.low), pct(e.high))}% of ${e.window}`;
  }
  const [lo, hi] = [tokens(e.low), tokens(e.high)];
  const low = lo.unit === hi.unit ? lo.n : `${lo.n}${lo.unit}`;
  return `usually ${span(low, hi.n)}${hi.unit} tokens`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");

/** A time to come, in local time: "14:20" today, "Wed 09:05" within the week, else "Nov 28". */
export function clockOf(iso: string, now: Date): string {
  const t = new Date(iso);
  const hm = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  if (t.toDateString() === now.toDateString()) return hm;
  if (t.getTime() - now.getTime() < 6 * 86_400_000) return `${DAYS[t.getDay()]} ${hm}`;
  return t.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * The window nearest its limit among those still current (an old one, past its reset, says nothing now); on a tie, the
 * one that resets sooner.
 */
function fullest(u: AgentUsage, now: Date): UsageWindow | null {
  const current = u.windows.filter((w) => w.resetsAt === null || Date.parse(w.resetsAt) > now.getTime());
  const resets = (w: UsageWindow) => (w.resetsAt ? Date.parse(w.resetsAt) : Number.POSITIVE_INFINITY);
  // Equally used: the one that resets sooner says more.
  const fuller = (w: UsageWindow, a: UsageWindow) =>
    w.usedPercent > a.usedPercent || (w.usedPercent === a.usedPercent && resets(w) < resets(a));
  return current.reduce<UsageWindow | null>((a, w) => (!a || fuller(w, a) ? w : a), null);
}

/** What's known when there's no gauge: free, this week's cost for an agent paid per token, else what errors said. */
function noGauge(u: AgentUsage): string {
  if (u.billing === "free") return "Free";
  if (u.billing === "api" && u.week.costUsd > 0) return "";
  return "No usage info";
}

/**
 * One agent's usage in a few words, the same in Settings → Agents and `ion status`: "62% of 5 h · resets 14:20",
 * "limited until 16:00", "Free", "No usage info"; this week's cost too for an agent paid per token, or one whose
 * billing ion can't tell but that reported a cost.
 */
export function usageLine(
  u: AgentUsage,
  now: Date,
): { text: string; percent: number | null; limited: boolean } {
  // Paid per token, or billing unknown with a cost the agent reported (a paid opencode model): this week's cost.
  const paid = u.billing === "api" || u.billing === null;
  const cost = paid && u.week.costUsd > 0 ? `this week $${u.week.costUsd.toFixed(2)}` : "";
  const join = (...parts: string[]) => parts.filter(Boolean).join(" · ");
  if (u.limitedUntil && Date.parse(u.limitedUntil) > now.getTime())
    return {
      text: join(`limited until ${clockOf(u.limitedUntil, now)}`, cost),
      percent: null,
      limited: true,
    };
  const w = fullest(u, now);
  if (!w) return { text: join(noGauge(u), cost), percent: null, limited: false };
  const pct = Math.round(w.usedPercent);
  const resets = w.resetsAt ? `resets ${clockOf(w.resetsAt, now)}` : "";
  return { text: join(`${pct}% of ${w.name}`, resets, cost), percent: pct, limited: false };
}

/** One check of an agent's pinned judge model on this computer: ion's judge eval cases, through the judge's prompt. */
export type JudgeCheckInfo = {
  agent: string;
  model: string;
  /** The day it ran (YYYY-MM-DD). */
  date: string;
  /** Nothing that must not pass was allowed. */
  pass: boolean;
  cases: number;
  /** The cases that must not pass that it allowed, by id. */
  dangerous: string[];
  /** Cases answered as labelled. */
  agreement: number;
  unsure: number;
  /** Cases it gave no verdict on (failed, too slow). */
  failed: number;
};

/** An agent's pinned judge model and ion's checks of it (Settings). */
export type JudgeStatus = {
  model: string;
  checked: boolean;
  shipped: boolean;
  last: JudgeCheckInfo | null;
  checking: boolean;
  /** ion's own check stopped at the agent's limit: its free use ran out (Plan 21, 2026-11-28). */
  ranOut?: true;
};

/** An agent, model ("": its own) and effort you picked in the composer (a new chat starts on it). */
export type LastPick = { harness: string; model: string; effort: EffortLevel | "" };

/**
 * ion's own models (PR #36, 2026-11-23). `quick` is "Ions think with" (ion chief's and every project ion's turns):
 * "<agent>[:<model>]" you picked in Settings → Agents, or "" for the strongest model you're signed in to, at `effort`
 * (null: High for your messages, Medium for routine turns). `judge` decides in Auto: yours, or "" for the first agent
 * along your order whose pinned judge model ion checked. `*Now` is whom each runs on now (the daemon resolves it).
 */
export type IonSettings = {
  quick: string;
  effort: EffortLevel | null;
  judge: string;
  /** Whom each runs on now, "<agent>[:<model>]"; null: none ready. */
  quickNow: string | null;
  /** Whether ion checked the judge's model now (one you set may not be: Settings says so). */
  judgeChecked: boolean;
  /** By agent id: its pinned judge model, checked (`shipped`: before shipping), its last check here, one going now. */
  judges: Record<string, JudgeStatus>;
  /** ion's brain when you picked none: the strongest model you're signed in to, at yours or High; null: none. */
  strongest: { agent: string; model: string | null; effort: EffortLevel } | null;
};
