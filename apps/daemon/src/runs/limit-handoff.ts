import { randomBytes } from "node:crypto";
import { clockOf, type DecisionScope, EV, type HandoffLimit, type IonEvent } from "@ion/schema";
import { UserError } from "../api/errors.js";
import type { NeedsService } from "../needs/index.js";
import type { Waits } from "../scheduler/index.js";
import type { Db, EventStore } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { decisionsView } from "../views/decisions.js";
import { needsView } from "../views/needs.js";
import { runsView } from "../views/runs.js";
import { believedReset, usageView } from "../views/usage.js";
import { CHECK_FIRST, chatBrief, type FileStat } from "./brief.js";

/** "Always continue on <agent> here": a decision for the project, kept with this key (the agent's id after it). */
const ALWAYS = "handoff:";

/** What ion's limit question is about: the agent that hit it, the one offered, what "Wait" means, the request. */
type Limit = HandoffLimit;
type Wake = { from: string; waitOn: string; until: string; guessed?: true; request?: string };
/** A waiting chat.handoff, as kept (a restart takes it up again). */
type Waiting = {
  kind?: string;
  to?: string;
  until?: string;
  guessed?: true;
  tries?: number;
  request?: string;
};
/** A limit a run hit: the reset the agent said, and the request the run was given (Auto's judge weighs it after). */
type Hit = { resetsAt?: string; request?: string };

/** A wait whose reset was a guess tries this many times (waiting again while still limited), then asks you. */
const RECHECKS = 3;
/** A wait already past when ion starts goes on this long after. */
const START_GRACE_MS = 5000;

type Deps = {
  store: EventStore;
  db: Db;
  needs: NeedsService;
  /** The agents signed in now, best first (quota-friendly first). */
  ready: () => Promise<string[]>;
  label: (harness: string) => string;
  /** Starts a run in the chat on this agent with ion's message (hidden: the chat shows its line); its run id. */
  start: (
    a: { chatId: string; harness: string; text: string; access?: "auto" | "full" },
    o: { request: string; answers?: string },
  ) => Promise<string>;
  /** The chat's worktree's changed files (its diff stat). */
  changed: (chatId: string) => Promise<FileStat[]>;
  waits: Waits;
  now?: () => Date;
  /** A chat's hold lifted without a run going on (a handoff that couldn't start): its queue may go on. */
  released?: (chatId: string) => void;
  /** Settings → Agents, "When an agent hits its limit": ask you (the default), continue on the next agent, or wait. */
  onLimit?: (chatId: string) => "ask" | "continue" | "wait";
  /** What a live run was given as your request (the judge's), read when it hits its limit. */
  requestOf?: (runId: string) => string | null;
  /**
   * With no other agent free, the first one that isn't ready and its command ("Set up Grok Build: grok login"), or
   * null (review of Plan 21 Task 2, 2026-11-23).
   */
  setUp?: () => Promise<string | null>;
};

type Usage = Record<string, { limitedUntil: string | null; limitGuessed?: true }>;

/** ion's guess when a limit doesn't say when it resets (as the usage view marks it). */
const GUESS_MS = 30 * 60_000;

/**
 * What to offer when `from` hit its limit: the first agent signed in and free (else one limited only by ion's guess:
 * it may be free again), and what Wait means: this agent's reset, or (none offered) the agent that resets first.
 */
function pickLimit(from: string, ready: string[], usage: Usage, o: { said: Hit; now: Date }): Limit {
  // The reset `from` said wins when its mark is gone (another session on it ended well meanwhile: tour, 2026-11-23).
  const until = (h: string) => usage[h]?.limitedUntil ?? (h === from ? (o.said.resetsAt ?? null) : null);
  const others = ready.filter((h) => h !== from);
  const free = others.filter((h) => !until(h));
  const to = free[0] ?? others.find((h) => usage[h]?.limitGuessed) ?? null;
  const resets = [from, ...others.filter((h) => until(h))]
    .map((h) => ({ h, at: until(h) ?? new Date(o.now.getTime() + GUESS_MS).toISOString() }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const wait = to ? resets.find((r) => r.h === from)! : resets[0]!;
  const guessed = wait.h === from ? !o.said.resetsAt : !!usage[wait.h]?.limitGuessed;
  return {
    ...{ from, to, waitOn: wait.h, until: wait.at },
    ...(guessed ? { guessed: true as const } : {}),
    ...(to && !free.includes(to) ? { maybe: true as const } : {}),
    ...(o.said.request !== undefined ? { request: o.said.request } : {}),
  };
}

/** A handoff or a wait that couldn't go on: one line in the daemon's log (the chat's queue says why too). */
const said = (x: unknown) => console.warn(`ion couldn't go on after a limit: ${(x as Error).message}`);

const continueLabel = (name: string) => `Continue on ${name}`;
const alwaysLabel = (name: string) => `Always continue on ${name} here`;
const WAIT = "Wait";

/** What ion tells an agent going on after its own limit reset (its session resumes: it knows the work). */
const BACK = `You stopped at your usage limit; it has reset. ${CHECK_FIRST} Then carry on.`;

/**
 * When a chat's run stops at its agent's limit, ion holds the chat and asks you: continue on another agent (one
 * signed in and not limited), wait for the reset, or always continue on that agent in this project. Continue is a
 * new run in the same chat (its worktree) with ion's brief of the work; Wait sends the chat on at the reset. Each chat
 * asks once per limit; "Always" continues without asking (and says so) while that agent is free.
 */
export class Handoffs {
  /** Runs that hit a limit, until their end (then the chat asks), with the reset the agent said. */
  private readonly hit = new Map<string, Hit>();
  /**
   * Chats held from their limited run's end until ion has asked (or continued): set before the end is announced, so
   * nothing queued goes out on the limited agent meanwhile, and one chat can't ask twice.
   */
  private readonly asking = new Set<string>();
  /** Chats that went on, unattended, on an agent limited only by ion's guess: the next limit asks you. */
  private readonly triedGuess = new Set<string>();
  /** Chats trying their agent again after a guessed reset: how many tries so far. */
  private readonly rechecks = new Map<string, number>();

  private readonly unlisten: () => void;

  constructor(private readonly d: Deps) {
    this.unlisten = d.store.onAppend((e) => this.seen(e));
    this.resume();
  }

  /** ion is stopping: no more questions, and no chat goes on (each waits again at the next start). */
  stop(): void {
    this.unlisten();
    this.d.waits.stop();
  }

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }

  private seen(e: IonEvent): void {
    const { chatId, runId } = e;
    if (!chatId) return;
    const d = e.data as { limit?: { resetsAt?: string }; status?: string; handoff?: true };
    // Your own message in a waiting chat (it goes on now), or the chat archived: the wait is off.
    if ((e.type === EV.messageSent && !d.handoff) || e.type === EV.chatArchived) this.cancel(chatId);
    if (!runId) return;
    if (e.type === EV.error && d.limit) this.hit.set(runId, this.hitOf(runId, d.limit, e.ts));
    else if (e.type === EV.runFinished) this.ended(chatId, runId, d.status);
  }

  /**
   * A limit a run hit: the reset the agent said, as ion believes it (checked, and within the agent's windows: security
   * scan, 2026-11-23); and the run's request while it's still live (an ion thread's is the ion's own, never the
   * brief: final review, 2026-11-23).
   */
  private hitOf(runId: string, limit: { resetsAt?: string }, ts: string): Hit {
    const harness = runsView.rows(this.d.db).find((r) => r.runId === runId)?.harness ?? "";
    const { resetsAt } = believedReset(this.d.db, harness, limit.resetsAt, Date.parse(ts));
    const request = this.d.requestOf?.(runId) ?? undefined;
    return { ...(resetsAt ? { resetsAt } : {}), ...(request !== undefined ? { request } : {}) };
  }

  /** You stopped the chat while it waited (or tried again after a reset): the wait is off, and stays off. */
  stopWaiting(chatId: string): void {
    if (!this.d.waits.has(chatId) && !this.rechecks.has(chatId)) return;
    this.cancel(chatId);
    this.line(chatId, { kind: "stopped", text: "Stopped waiting" });
  }

  private line(chatId: string, data: Record<string, unknown>): void {
    this.d.store.append({ chatId, runId: null, origin: "daemon", type: EV.chatHandoff, data });
  }

  /** The chat's wait is off (your message, Stop, the chat archived). */
  cancel(chatId: string): void {
    this.d.waits.cancel(chatId);
    this.triedGuess.delete(chatId);
    this.rechecks.delete(chatId);
  }

  /** Whether the chat is held after its agent's limit: being asked, asked and waiting for you, or waiting for a reset. */
  holding(chatId: string): boolean {
    return this.asking.has(chatId) || this.openQuestion(chatId) !== null || this.d.waits.has(chatId);
  }

  /** A run ended: one that failed on a limit asks (or waits again); one that went well ends any re-checking. */
  private ended(chatId: string, runId: string, status: string | undefined): void {
    const limit = this.hit.get(runId);
    this.hit.delete(runId);
    // A try that ended any other way than on the limit ends the re-checking.
    if (!limit || status !== "failed") {
      this.triedGuess.delete(chatId);
      return void this.rechecks.delete(chatId);
    }
    if (this.asking.has(chatId) || this.openQuestion(chatId)) return;
    this.asking.add(chatId); // held now: the queue hears of the run's end right after this
    queueMicrotask(() => void this.limited(chatId, runId, limit).catch(said));
  }

  /** The chat's open limit question, if any. */
  private openQuestion(chatId: string): string | null {
    for (const n of this.d.needs.open(chatId)) if (this.limitOf(chatId, n.needId)) return n.needId;
    return null;
  }

  private limitOf(chatId: string, needId: string): Limit | null {
    const raised = this.d.store
      .read({ chatId, types: [EV.needRaised] })
      .find((e) => (e.data as { needId: string }).needId === needId);
    return ((raised?.data as { limit?: Limit } | undefined)?.limit ?? null) as Limit | null;
  }

  /** Whether this open question is ion's limit question (answered here, not as an agent's). */
  owns(needId: string): boolean {
    const need = needsView.find(this.d.db, needId);
    return !!need?.open && this.limitOf(need.chatId, needId) !== null;
  }

  private async limited(chatId: string, runId: string, limit: Hit): Promise<void> {
    try {
      if (this.waitAgain(chatId, runId, limit)) return;
      const from = runsView.rows(this.d.db).find((r) => r.runId === runId)?.harness;
      if (!from) return;
      const now = this.now();
      const [ready, usage] = [await this.d.ready(), usageView.agents(this.d.db, now)];
      const always = this.alwaysOn(chatId, from, ready, usage);
      if (always) await this.continueOn(chatId, from, always, { auto: true, request: limit.request });
      else await this.byChoice(chatId, runId, pickLimit(from, ready, usage, { said: limit, now }), limit);
    } finally {
      this.asking.delete(chatId);
      this.lifted(chatId);
    }
  }

  /**
   * What ion does at a limit (your "Always" for the project came first): in chats ions start, continue on the next
   * free agent (unattended: on Auto); in yours, ask you (the user, 2026-11-24). With no agent free, ion asks.
   */
  private async byChoice(chatId: string, runId: string, l: Limit, said: Hit): Promise<void> {
    const choice = this.d.onLimit?.(chatId) ?? "ask";
    // One limited only by ion's guess is tried once (trying tells); still limited, ion asks (no going round).
    const once = !l.maybe || !this.triedGuess.has(chatId);
    if (choice === "continue" && l.to && once) {
      if (l.maybe) this.triedGuess.add(chatId);
      return this.continueOn(chatId, l.from, l.to, { request: l.request });
    }
    if (choice === "wait") return this.wait(chatId, l);
    const next = l.to ? null : await this.d.setUp?.().catch(() => null);
    this.ask(chatId, runId, l, { ...said, setUp: next ?? null });
  }

  /** The chat's hold may have lifted: its queue hears of it (a run started meanwhile keeps the chat busy anyway). */
  private lifted(chatId: string): void {
    if (this.holding(chatId)) return;
    this.d.released?.(chatId);
    for (const fn of this.releases) fn(chatId);
  }

  private readonly releases: ((chatId: string) => void)[] = [];

  /** `fn` hears when a chat's hold lifts without a run going on (its queue may go on now). */
  onReleased(fn: (chatId: string) => void): void {
    this.releases.push(fn);
  }

  /**
   * Your "Always continue on <agent> here", when that agent is signed in and not limited (one limited by ion's guess
   * only is tried); null otherwise, and ion asks.
   */
  private alwaysOn(chatId: string, from: string, ready: string[], usage: Usage): string | null {
    const to = decisionsView.newestKey(this.d.db, this.projectOf(chatId), ALWAYS)?.slice(ALWAYS.length);
    if (!to || to === from || !ready.includes(to)) return null;
    return !usage[to]?.limitedUntil || usage[to]?.limitGuessed ? to : null;
  }

  private projectOf(chatId: string): string {
    return chatsView.list(this.d.db).find((c) => c.chatId === chatId)?.projectId ?? "";
  }

  /** ion's question; `said.setUp`: with no other agent free, the next one to set up and its command. */
  private ask(chatId: string, runId: string, l: Limit, said: Hit & { setUp: string | null }): void {
    const L = this.d.label;
    const now = this.now();
    const reset = said.resetsAt ? ` (resets ${clockOf(said.resetsAt, now)})` : "";
    const on = l.waitOn === l.from ? "" : ` on ${L(l.waitOn)}`;
    const wait = { label: WAIT, consequence: `ion goes on at ${clockOf(l.until, now)}${on}.` };
    const question = l.to
      ? `${L(l.from)} hit its limit${reset}. Continue on ${L(l.to)}, or wait?`
      : [`${L(l.from)} hit its limit${reset}. No other agent is free.`, said.setUp].filter(Boolean).join(" ");
    const choices = l.to
      ? [
          {
            label: continueLabel(L(l.to)) + (l.maybe ? " (may be free again)" : ""),
            consequence: l.maybe
              ? "ion tries it, and asks again if it's still limited."
              : "It picks up where this left off, with a summary.",
            recommended: true,
          },
          wait,
          { label: alwaysLabel(L(l.to)), consequence: "Next time ion continues without asking." },
        ]
      : [wait];
    this.d.needs.raiseAsk({ chatId, runId, question, choices, noRemember: true, limit: l });
  }

  /**
   * Your answer: choice `pick` (1-based), or your own words (they go to the agent offered, with the brief). Continue
   * (or Always, or Continue with Remember) starts the other agent first: if it can't start, the question stays open.
   * Wait sets the chat to go on at the reset.
   */
  async answer(needId: string, pick: number | string, scope: DecisionScope): Promise<void> {
    const { need, l, label, words } = this.picked(needId, pick);
    if (label === WAIT && !words) {
      this.d.needs.answered(needId, label, "chat");
      return this.wait(need.chatId, l);
    }
    const to = l.to;
    if (!to) throw new UserError("Pick Wait: no other agent is free");
    await this.continueOn(need.chatId, l.from, to, {
      needId,
      request: l.request,
      ...(words ? { words } : {}),
    });
    const always = !words && (label === alwaysLabel(this.d.label(to)) || scope !== "chat");
    this.d.needs.answered(needId, label, always ? "project" : "chat");
    if (always) this.keep({ chatId: need.chatId, needId, l, everywhere: scope === "everywhere" });
  }

  /** The question your answer is to, and what you picked: a choice's label, or your own words. */
  private picked(needId: string, pick: number | string) {
    const need = this.d.needs.openNeed(needId);
    const l = this.limitOf(need.chatId, needId);
    const choices = this.d.needs.open(need.chatId).find((n) => n.needId === needId)?.choices ?? [];
    const words = typeof pick === "string" ? pick.trim().slice(0, 2000) : "";
    const label = words || (typeof pick === "number" ? choices[pick - 1]?.label : undefined);
    if (!l || !label) throw new UserError(`Pick 1 to ${choices.length}`);
    return { need, l, label, words };
  }

  /** "Always continue on <agent> here", kept as your decision for the project (or everywhere). */
  private keep(k: { chatId: string; needId: string; l: Limit; everywhere: boolean }): void {
    const { chatId, needId, l } = k;
    const question = "When an agent hits its limit here";
    const data = {
      ...{
        decisionId: `d${randomBytes(4).toString("hex")}`,
        needId,
        projectId: this.projectOf(chatId),
        question,
      },
      ...{
        choice: `Always continue on ${this.d.label(l.to ?? "")}`,
        scope: k.everywhere ? "everywhere" : "project",
        by: "you",
        allowKey: ALWAYS + l.to,
      },
    };
    this.d.store.append({ chatId, runId: null, origin: "daemon", type: EV.decisionRecorded, data });
  }

  /** The chat's access, as its last run had it: a handoff keeps it (ruling, 2026-11-22). */
  private accessOf(events: IonEvent[]): { access?: "auto" | "full" } {
    const last = events.findLast((e) => e.type === EV.runQueued && (e.data as { access?: string }).access);
    const access = (last?.data as { access?: "auto" | "full" } | undefined)?.access;
    return access ? { access } : {};
  }

  /**
   * What Auto's judge weighs on the run that goes on: the limited run's request when ion has it; else your first
   * message, but never in a thread ion started (its first message is the ion's own brief): none there, stricter.
   */
  private request(chatId: string, events: IonEvent[], had: string | undefined): string {
    if (had !== undefined) return had;
    if (chatsView.list(this.d.db).find((c) => c.chatId === chatId)?.by === "ion") return "";
    const first = events.find((e) => e.type === EV.messageSent && !(e.data as { handoff?: true }).handoff);
    return String((first?.data as { text?: string } | undefined)?.text ?? "");
  }

  private async continueOn(
    chatId: string,
    from: string,
    to: string,
    o: { needId?: string; words?: string; auto?: true; request?: string },
  ): Promise<void> {
    const L = this.d.label;
    const events = this.d.store.read({ chatId });
    const files = await this.d.changed(chatId).catch(() => []);
    // The user, 2026-11-23 ("Auto when unattended"): the chat's access carries over only when you said Continue
    // yourself; a handoff nobody watched (Always, a wait going on on another agent) starts the new agent on Auto.
    const was = this.accessOf(events);
    const access = o.needId ? was : { access: "auto" as const };
    const onAuto = !o.needId && was.access === "full" ? " (Auto)" : "";
    const adds = o.words ? `\n\nThe user adds: ${JSON.stringify(o.words)}` : "";
    const text = `${chatBrief(events, files)}\n\n${L(from)} stopped at its usage limit; carry on with the work in this worktree.${adds}`;
    await this.d.start(
      { chatId, harness: to, text, ...access },
      { request: this.request(chatId, events, o.request), ...(o.needId ? { answers: o.needId } : {}) },
    );
    const auto = o.auto ? " · always" : "";
    const line = {
      ...{ kind: "continued", text: `Continued on ${L(to)}${onAuto} — ${L(from)} hit its limit${auto}`, to },
    };
    this.d.store.append({ chatId, runId: null, origin: "daemon", type: EV.chatHandoff, data: line });
  }

  private wait(chatId: string, l: Limit): void {
    const text = `Waits for ${this.d.label(l.waitOn)} — ${clockOf(l.until, this.now())}`;
    const data = {
      kind: "waiting",
      text,
      to: l.waitOn,
      until: l.until,
      ...(l.guessed ? { guessed: true } : {}),
      ...(l.request !== undefined ? { request: l.request } : {}),
    };
    this.line(chatId, data);
    this.schedule(chatId, l);
  }

  /** A wake-up the scheduler refuses (a time that isn't a date) falls back to ion's guess, tried then. */
  private schedule(chatId: string, l: Wake): void {
    if (this.wake(chatId, l)) return;
    this.wake(chatId, {
      ...l,
      until: new Date(this.now().getTime() + GUESS_MS).toISOString(),
      guessed: true,
    });
  }

  private wake(chatId: string, l: Wake): boolean {
    return this.d.waits.at(chatId, new Date(l.until), () => {
      // A guessed reset is checked by trying: a try that hits the limit again waits again (waitAgain).
      if (l.guessed) this.rechecks.set(chatId, (this.rechecks.get(chatId) ?? 0) + 1);
      void this.goOn(chatId, l)
        .catch((x) => this.couldNot(chatId, x))
        .finally(() => this.lifted(chatId));
    });
  }

  /** A wait whose run couldn't start: the chat says why, reads as failed again, and isn't taken up again. */
  private couldNot(chatId: string, x: unknown): void {
    said(x);
    this.rechecks.delete(chatId);
    this.line(chatId, { kind: "failed", text: `Couldn't go on: ${(x as Error).message}`.slice(0, 200) });
  }

  /**
   * A chat trying again after a guessed reset hit the limit again: it waits again (for the reset the agent says now,
   * else another guess), a few times, without asking; then it asks you. False when the chat isn't trying again.
   */
  private waitAgain(chatId: string, runId: string, limit: Hit): boolean {
    const tries = this.rechecks.get(chatId);
    if (tries === undefined) return false;
    const run = runsView.rows(this.d.db).find((r) => r.runId === runId);
    if (tries >= RECHECKS || !run?.harness) return (void this.rechecks.delete(chatId), false);
    const now = this.now();
    const until =
      limit.resetsAt ??
      usageView.agents(this.d.db, now)[run.harness]?.limitedUntil ??
      new Date(now.getTime() + GUESS_MS).toISOString();
    const harness = run.harness;
    const text = `Still at its limit — tries again at ${clockOf(until, now)}`;
    const data = {
      kind: "waiting",
      text,
      to: harness,
      until,
      tries,
      ...(limit.resetsAt ? {} : { guessed: true }),
      ...(limit.request !== undefined ? { request: limit.request } : {}),
    };
    this.line(chatId, data);
    this.schedule(chatId, {
      ...{ from: harness, waitOn: harness, until },
      ...(limit.resetsAt ? {} : { guessed: true }),
      ...(limit.request !== undefined ? { request: limit.request } : {}),
    });
    return true;
  }

  /** The reset came: the chat goes on, on its own agent (its session resumes) or the one that reset first. */
  private async goOn(chatId: string, l: Wake): Promise<void> {
    if (l.waitOn !== l.from) return this.continueOn(chatId, l.from, l.waitOn, { request: l.request });
    const events = this.d.store.read({ chatId });
    await this.d.start(
      { chatId, harness: l.from, text: BACK, ...this.accessOf(events) },
      { request: this.request(chatId, events, l.request) },
    );
  }

  /** The chat's wait, when its last word is one (nothing sent there since, not stopped, not failed). */
  private waitingOf(chatId: string): (Waiting & { to: string; until: string }) | null {
    const last = this.d.store.read({ chatId, types: [EV.chatHandoff, EV.messageSent] }).at(-1);
    if (last?.type !== EV.chatHandoff) return null;
    const d = last.data as Waiting;
    return d.kind === "waiting" && d.to && d.until ? { ...d, to: d.to, until: d.until } : null;
  }

  /**
   * At ion's start: chats still waiting for a reset (nothing sent there since) wait again; one already past goes on a
   * few seconds after (once ion listens: its runs reach ion's tools).
   */
  private resume(): void {
    const soonest = new Date(this.now().getTime() + START_GRACE_MS).toISOString();
    for (const c of chatsView.list(this.d.db).filter((x) => !x.archived)) {
      const d = this.waitingOf(c.chatId);
      if (d) this.takeUp(c.chatId, d, soonest);
    }
  }

  private takeUp(chatId: string, d: Waiting & { to: string; until: string }, soonest: string): void {
    const from = runsView.rows(this.d.db).findLast((r) => r.chatId === chatId)?.harness ?? d.to;
    if (d.tries) this.rechecks.set(chatId, d.tries);
    this.schedule(chatId, {
      ...{ from, waitOn: d.to, until: d.until < soonest ? soonest : d.until },
      ...(d.guessed ? { guessed: true as const } : {}),
      ...(d.request !== undefined ? { request: d.request } : {}),
    });
  }
}
