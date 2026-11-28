import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadUserConfig, type UserConfig } from "@ion/config";
import {
  type AgentCheckItem,
  type AgentCheckRecord,
  type AgentCheckRow,
  type AgentChecksInfo,
  type Billing,
  checkLines,
  checksFailed,
  type HarnessInfo,
} from "@ion/schema";
import { dayOf, type Quiet, quietNow, type Window } from "../notify/clock.js";

/** How often ion looks whether it's time to check (and whether a note waits for quiet hours to end). */
const LOOK_MS = 5 * 60_000;
/**
 * How long it waits for agents still being read (a fresh daemon's first reads): at night, longer; Check now, a little;
 * Settings, a moment (one slow agent can't hold the page).
 */
const NIGHT_WAIT_MS = 30_000;
const NOW_WAIT_MS = 5_000;
const INFO_WAIT_MS = 1_500;
/** A quiet night: quiet hours this old, nothing in ion for this long, and no agent started this close to the end. */
const SETTLED_MS = 60 * 60_000;
const IDLE_MS = 30 * 60_000;
const LAST_START_MS = 30 * 60_000;
/** The night's hours when quiet hours are off. */
const NIGHT: Quiet = { on: true, from: "01:00", to: "06:00" };
/** Claude Code: checked only when you pick it, even when it would be free (save Claude; the user, 2026-11-28). */
const CLAUDE = "claude-code";

/** What a night's check costs an agent, by how it bills on the model it checks with. */
const COST: Record<Billing, string> = {
  free: "Free",
  subscription: "A little of your plan",
  api: "About a cent a night",
};

export type AgentChecksDeps = {
  dataDir: string;
  configFile: string;
  /** The agents ion knows, as now. */
  agents: (waitMs: number) => Promise<HarnessInfo[]>;
  /** Whether the agent is marked limited now. */
  limited: (id: string) => boolean;
  /** How the agent bills on this model (null: its own default). */
  billing: (id: string, model: string | null) => Promise<Billing | null>;
  /** The model a check runs on (its small judge model, when it has one; null: its default). */
  model: (id: string) => string | null;
  /** The agent's checks: it starts, answers, reaches ion's tools, its calls reach the gate, still signed in. */
  smoke: (agent: string, model: string | null, signal: AbortSignal) => Promise<AgentCheckItem[]>;
  /** The judge checked again when its model changed (PR #36's check); null when there's nothing to check. */
  judge?: (agent: string) => Promise<AgentCheckItem | null>;
  /** A "needs you" note (held by the caller until quiet hours end: it's only called outside them). */
  notify: (body: string) => void;
  /** Whether a chat is working now (the check waits for an idle computer). */
  working: () => boolean;
  /** When something last happened in ion (its last event: a chat, an ion's turn, tidying memory), if ever. */
  lastEvent: () => Date | null;
  now?: () => Date;
};

/** A run of the checks: how long it waits for agents being read, whose it is, and (the night's) when it must end. */
type Run = { waitMs: number; by: "night" | "now"; end?: Date };

/** What's kept (agent-checks.json): the night last checked, each agent's last check, failures noted and to note. */
type Kept = { night: string | null; last: AgentCheckRecord[]; noted: string[]; pending: string[] };

/** The hours checks may run in: quiet hours (Settings → Notifications), else 01:00–06:00. */
function hoursOf(c: UserConfig): Quiet {
  const q = c.notifications.quiet;
  return q.on && q.from !== q.to ? q : NIGHT;
}

/** The window checks may run in now, or null (the working day). */
const checkWindow = (c: UserConfig, now: Date): Window | null => quietNow(hoursOf(c), now);

/**
 * Why an agent isn't in tonight's check, or null when it is: never one you avoid or one that's limited; one that isn't
 * free (and Claude Code) only when you picked it. One checked before that's now signed out is in: that's what broke.
 */
function whyNot(
  h: HarnessInfo,
  o: { picked: boolean; billing: Billing | null; avoided: boolean; limited: boolean; before: boolean },
): string | null {
  if (!h.installed) return "Not installed";
  if (!h.signedIn && !o.before) return "Not signed in";
  if (o.avoided) return "Avoided";
  if (o.limited) return "Limited";
  if (o.picked) return null;
  return h.id !== CLAUDE && o.billing === "free" ? null : "Only if you pick it";
}

/**
 * "Check the agents each night" (Plan 21 Task 5): when it's on, once a night in quiet hours (else 01:00–06:00) and
 * while no chat works, a small check of each agent that's in (whyNot), one at a time; the judge again when its model
 * changed. A failure is one "needs you" note, the first time only, after quiet hours; a pass clears it.
 */
export class AgentChecks {
  private readonly file: string;
  private going: Promise<void> | null = null;
  private readonly abort = new AbortController();
  private timer: ReturnType<typeof setInterval> | undefined;
  /** The night checked last, also when its file can't be read or written. */
  private lastNight: string | null = null;

  constructor(private readonly d: AgentChecksDeps) {
    this.file = join(d.dataDir, "agent-checks.json");
  }

  /** Looks every few minutes; returns a stop (a check going is told to stop, its agent closed). */
  start(): () => void {
    this.timer = setInterval(() => void this.tick().catch(() => {}), LOOK_MS);
    this.timer.unref?.();
    return () => this.stop();
  }

  stop(): void {
    clearInterval(this.timer);
    this.abort.abort();
  }

  /** Waits for a check going now to end. */
  async settled(): Promise<void> {
    await this.going?.catch(() => {});
  }

  /** ion is closing: no more looks, and a check going is stopped (its agent closed) before it goes. */
  async close(): Promise<void> {
    this.stop();
    await this.settled();
  }

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }

  /** A note waiting is said once quiet hours are over; then, at night, tonight's check if it's due. */
  async tick(): Promise<void> {
    const { config: c, error } = loadUserConfig(this.d.configFile);
    if (error || this.going) return;
    const now = this.now();
    this.sayPending(c, now);
    if (!c.checks.nightly) return;
    const w = checkWindow(c, now);
    if (!w || this.checked(w) || !this.quiet(w, now)) return;
    await this.runAll(c, { waitMs: NIGHT_WAIT_MS, by: "night", end: w.end });
  }

  /** Tonight's check ran (or started): once a night, whatever it finds. */
  private checked(w: Window): boolean {
    const night = dayOf(w.start);
    return this.lastNight === night || this.kept().night === night;
  }

  private markNight(w: Window): void {
    this.lastNight = dayOf(w.start);
    this.keep({ ...this.kept(), night: this.lastNight });
  }

  /** A quiet night: its quiet hours an hour old, nothing in ion for 30 minutes, no chat working, not near its end. */
  private quiet(w: Window, now: Date): boolean {
    const t = now.getTime();
    const last = this.d.lastEvent()?.getTime() ?? 0;
    if (t - w.start.getTime() < SETTLED_MS || t - last < IDLE_MS) return false;
    return w.end.getTime() - t > LAST_START_MS && !this.d.working();
  }

  /** Checks now, as the night would (Check now, `ion agents check --now`); one going is waited for instead. */
  async runNow(): Promise<AgentChecksInfo> {
    if (this.going) await this.settled();
    else await this.runAll(loadUserConfig(this.d.configFile).config, { waitMs: NOW_WAIT_MS, by: "now" });
    return this.info();
  }

  /** On or off, going now, its hours, each agent's part, the last checks. */
  async info(): Promise<AgentChecksInfo> {
    const { config: c } = loadUserConfig(this.d.configFile);
    const h = hoursOf(c);
    return {
      nightly: c.checks.nightly,
      running: this.going !== null,
      window: `${h.from}–${h.to}`,
      agents: await this.rows(c, INFO_WAIT_MS),
      last: this.kept().last,
    };
  }

  /** A run: the night's (until `end`'s last half hour) or yours now; yours in the night counts as the night's. */
  private runAll(c: UserConfig, run: Run): Promise<void> {
    const w = checkWindow(c, this.now());
    if (w) this.markNight(w);
    const p = this.each(c, run).finally(() => {
      this.going = null;
    });
    this.going = p;
    return p;
  }

  private async each(c: UserConfig, run: Run): Promise<void> {
    for (const row of (await this.rows(c, run.waitMs)).filter((r) => r.included)) {
      if (this.abort.signal.aborted || this.late(run)) return;
      const checks = await this.one(row.agent);
      if (this.abort.signal.aborted) return;
      this.record({ agent: row.agent, label: row.label, at: this.now().toISOString(), by: run.by, checks });
    }
    this.sayPending(loadUserConfig(this.d.configFile).config, this.now());
  }

  /** The night's last half hour: no agent starts then. */
  private late(run: Run): boolean {
    return !!run.end && run.end.getTime() - this.now().getTime() <= LAST_START_MS;
  }

  /** One agent's checks, and its judge's when that model changed; a check that throws is a failed one. */
  private async one(agent: string): Promise<AgentCheckItem[]> {
    const checks = await this.d
      .smoke(agent, this.d.model(agent), this.abort.signal)
      .catch((e: unknown) => [{ name: "Starts", ok: false, note: (e as Error).message }]);
    const judge = await this.d.judge?.(agent).catch(() => null);
    return judge ? [...checks, judge] : checks;
  }

  private async rows(c: UserConfig, waitMs: number): Promise<AgentCheckRow[]> {
    const before = new Set(this.kept().last.map((r) => r.agent));
    const agents = (await this.d.agents(waitMs)).filter((h) => h.installed);
    return Promise.all(agents.map((h) => this.row(c, h, before.has(h.id))));
  }

  /** One agent's part; how it bills is asked only of one that could be in (the agent is asked: it takes a moment). */
  private async row(c: UserConfig, h: HarnessInfo, before: boolean): Promise<AgentCheckRow> {
    const picked = c.checks.agents.includes(h.id);
    const o = { picked, avoided: c.agents[h.id]?.avoid === true, limited: this.d.limited(h.id), before };
    const out = whyNot(h, { ...o, billing: null });
    const asked = out === null || out === "Only if you pick it";
    const billing =
      asked && h.signedIn ? await this.d.billing(h.id, this.d.model(h.id)).catch(() => null) : null;
    const why = asked ? whyNot(h, { ...o, billing }) : out;
    const cost = billing ? COST[billing] : "Cost unknown";
    return { agent: h.id, label: h.label, included: why === null, why, picked, cost };
  }

  /** Keeps the agent's check; a new failure is to be noted (once), a pass clears it. */
  private record(r: AgentCheckRecord): void {
    const k = this.kept();
    const last = [...k.last.filter((x) => x.agent !== r.agent), r];
    const failed = checksFailed(r) > 0;
    const noted = k.noted.filter((a) => a !== r.agent);
    const pending = k.pending.filter((a) => a !== r.agent);
    if (failed) noted.push(r.agent);
    // New, or still waiting to be said (quiet hours): said once.
    if (failed && (!k.noted.includes(r.agent) || k.pending.includes(r.agent))) pending.push(r.agent);
    this.keep({ ...k, last, noted, pending });
  }

  /** The failures waiting to be said, in one note, once quiet hours are over. */
  private sayPending(c: UserConfig, now: Date): void {
    const k = this.kept();
    // Held through the hours checks run in: quiet hours, else until 06:00.
    if (!k.pending.length || quietNow(hoursOf(c), now)) return;
    const lines = checkLines(
      k.last.filter((r) => k.pending.includes(r.agent)),
      now,
    );
    this.keep({ ...k, pending: [] });
    if (lines.length) this.d.notify(lines.join("; "));
  }

  private kept(): Kept {
    try {
      const k = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Kept>;
      return { night: k.night ?? null, last: k.last ?? [], noted: k.noted ?? [], pending: k.pending ?? [] };
    } catch {
      return { night: null, last: [], noted: [], pending: [] };
    }
  }

  private keep(k: Kept): void {
    try {
      writeFileSync(this.file, `${JSON.stringify(k, null, 2)}\n`, { mode: 0o600 });
    } catch {
      // not kept: checked again at the next look
    }
  }
}
