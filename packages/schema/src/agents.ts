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
};

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
  if (n >= 1_000_000) return { n: String(Math.round(n / 100_000) / 10), unit: "M" };
  if (n >= 1000) return { n: String(Math.round(n / 1000)), unit: "k" };
  return { n: String(n), unit: "" };
}

/** Low to high, or one figure when they're the same: "40–120k", "5–10%". */
const span = (low: string, high: string) => (low === high ? high : `${low}–${high}`);

/**
 * What a task usually takes, in words: "usually 40–120k tokens", "usually $0.20–$0.60", "usually 5–10% of 5 h".
 * A share rounds to whole percent, never below 1.
 */
export function estimateText(e: TaskEstimate): string {
  const usd = (n: number) => "$" + n.toFixed(2);
  if (e.unit === "usd") return `usually ${span(usd(e.low), usd(e.high))}`;
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
  return "Learned from errors";
}

/**
 * One agent's usage in a few words, the same in Settings → Agents and `ion status`: "62% of 5 h · resets 14:20",
 * "limited until 16:00", "Free", "Learned from errors"; this week's cost too for an agent paid per token, or one whose
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
