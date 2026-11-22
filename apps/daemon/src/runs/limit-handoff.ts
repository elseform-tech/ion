import { randomBytes } from "node:crypto";
import { type DecisionScope, EV, type IonEvent } from "@ion/schema";
import { UserError } from "../api/errors.js";
import type { NeedsService } from "../needs/index.js";
import type { Waits } from "../scheduler/index.js";
import type { Db, EventStore } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { decisionsView } from "../views/decisions.js";
import { needsView } from "../views/needs.js";
import { runsView } from "../views/runs.js";
import { usageView } from "../views/usage.js";
import { CHECK_FIRST, chatBrief, type FileStat } from "./brief.js";

/** "Always continue on <agent> here": a decision for the project, kept with this key (the agent's id after it). */
const ALWAYS = "handoff:";

/** What ion's limit question is about: the agent that hit it, the one offered, and what "Wait" means. */
type Limit = { from: string; to: string | null; waitOn: string; until: string; guessed?: true; maybe?: true };
type Wake = { from: string; waitOn: string; until: string; guessed?: true };

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
    a: { chatId: string; harness: string; text: string },
    o: { request: string; answers?: string },
  ) => Promise<string>;
  /** The chat's worktree's changed files (its diff stat). */
  changed: (chatId: string) => Promise<FileStat[]>;
  waits: Waits;
  now?: () => Date;
};

type Usage = Record<string, { limitedUntil: string | null; limitGuessed?: true }>;

/** ion's guess when a limit doesn't say when it resets (as the usage view marks it). */
const GUESS_MS = 30 * 60_000;

/**
 * What to offer when `from` hit its limit: the first agent signed in and free (else one limited only by ion's guess:
 * it may be free again), and what Wait means: this agent's reset, or (none offered) the agent that resets first.
 */
function pickLimit(
  from: string,
  ready: string[],
  usage: Usage,
  o: { said: { resetsAt?: string }; now: Date },
): Limit {
  const until = (h: string) => usage[h]?.limitedUntil ?? null;
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
  };
}

/** A time as the chat says it: "16:00" today, "Tue 16:00" another day. */
export function clockOf(iso: string, now: Date): string {
  const t = new Date(iso);
  const hm = t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return t.toDateString() === now.toDateString()
    ? hm
    : `${t.toLocaleDateString([], { weekday: "short" })} ${hm}`;
}

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
  private readonly hit = new Map<string, { resetsAt?: string }>();
  /** Chats being asked right now (the agents are being read), so one chat can't ask twice. */
  private readonly asking = new Set<string>();
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
    if (!chatId || !runId) return;
    const d = e.data as { limit?: { resetsAt?: string }; status?: string; handoff?: true };
    if (e.type === EV.error && d.limit) this.hit.set(runId, d.limit);
    else if (e.type === EV.runFinished) this.ended(chatId, runId, d.status);
    // Your own message in a waiting chat: it goes on now, so the wait is off.
    else if (e.type === EV.messageSent && !d.handoff) {
      this.d.waits.cancel(chatId);
      this.rechecks.delete(chatId);
    }
  }

  /** A run ended: one that failed on a limit asks (or waits again); one that went well ends any re-checking. */
  private ended(chatId: string, runId: string, status: string | undefined): void {
    const limit = this.hit.get(runId);
    this.hit.delete(runId);
    if (status === "done") this.rechecks.delete(chatId);
    if (limit && status === "failed")
      queueMicrotask(() => void this.limited(chatId, runId, limit).catch((x) => console.warn(x)));
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

  private async limited(chatId: string, runId: string, limit: { resetsAt?: string }): Promise<void> {
    if (this.asking.has(chatId) || this.openQuestion(chatId)) return;
    if (this.waitAgain(chatId, runId, limit)) return;
    this.asking.add(chatId);
    try {
      const from = runsView.rows(this.d.db).find((r) => r.runId === runId)?.harness;
      if (!from) return;
      const now = this.now();
      const l = pickLimit(from, await this.d.ready(), usageView.agents(this.d.db, now), { said: limit, now });
      const always = decisionsView.newestKey(this.d.db, this.projectOf(chatId), ALWAYS)?.slice(ALWAYS.length);
      if (always && always === l.to && !l.maybe) await this.continueOn(chatId, from, always, {});
      else this.ask(chatId, runId, l, limit);
    } finally {
      this.asking.delete(chatId);
    }
  }

  private projectOf(chatId: string): string {
    return chatsView.list(this.d.db).find((c) => c.chatId === chatId)?.projectId ?? "";
  }

  private ask(chatId: string, runId: string, l: Limit, said: { resetsAt?: string }): void {
    const L = this.d.label;
    const now = this.now();
    const reset = said.resetsAt ? ` (resets ${clockOf(said.resetsAt, now)})` : "";
    const on = l.waitOn === l.from ? "" : ` on ${L(l.waitOn)}`;
    const wait = { label: WAIT, consequence: `ion goes on at ${clockOf(l.until, now)}${on}.` };
    const question = l.to
      ? `${L(l.from)} hit its limit${reset}. Continue on ${L(l.to)}, or wait?`
      : `${L(l.from)} hit its limit${reset}. No other agent is free.`;
    const choices = l.to
      ? [
          {
            label: continueLabel(L(l.to)) + (l.maybe ? " (may be free again)" : ""),
            consequence: l.maybe
              ? "It may be free again: ion tries it, and asks again if it isn't."
              : "It picks up in this worktree with a summary of the work.",
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
    await this.continueOn(need.chatId, l.from, to, { needId, ...(words ? { words } : {}) });
    const always = !words && (label === alwaysLabel(this.d.label(to)) || scope !== "chat");
    this.d.needs.answered(needId, label, always ? "project" : "chat");
    if (always)
      this.keep({ chatId: need.chatId, needId, l, choice: label, everywhere: scope === "everywhere" });
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
  private keep(k: { chatId: string; needId: string; l: Limit; choice: string; everywhere: boolean }): void {
    const { chatId, needId, l, choice } = k;
    const question = `When ${this.d.label(l.from)} hits its limit`;
    const data = {
      ...{
        decisionId: `d${randomBytes(4).toString("hex")}`,
        needId,
        projectId: this.projectOf(chatId),
        question,
      },
      ...{ choice, scope: k.everywhere ? "everywhere" : "project", by: "you", allowKey: ALWAYS + l.to },
    };
    this.d.store.append({ chatId, runId: null, origin: "daemon", type: EV.decisionRecorded, data });
  }

  /** The chat's first message by you: the request the judge weighs in ion's runs. */
  private request(events: IonEvent[]): string {
    const first = events.find((e) => e.type === EV.messageSent && !(e.data as { handoff?: true }).handoff);
    return String((first?.data as { text?: string } | undefined)?.text ?? "");
  }

  private async continueOn(
    chatId: string,
    from: string,
    to: string,
    o: { needId?: string; words?: string },
  ): Promise<void> {
    const L = this.d.label;
    const events = this.d.store.read({ chatId });
    const files = await this.d.changed(chatId).catch(() => []);
    const adds = o.words ? `\n\nThe user adds: ${JSON.stringify(o.words)}` : "";
    const text = `${chatBrief(events, files)}\n\n${L(from)} stopped at its usage limit; carry on with the work in this worktree.${adds}`;
    await this.d.start(
      { chatId, harness: to, text },
      { request: this.request(events), ...(o.needId ? { answers: o.needId } : {}) },
    );
    const auto = o.needId ? "" : " · always here";
    const line = { kind: "continued", text: `Continued on ${L(to)} — ${L(from)} hit its limit${auto}`, to };
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
    };
    this.d.store.append({ chatId, runId: null, origin: "daemon", type: EV.chatHandoff, data });
    this.schedule(chatId, l);
  }

  private schedule(chatId: string, l: Wake): void {
    this.d.waits.at(chatId, new Date(l.until), () => {
      // A guessed reset is checked by trying: a try that hits the limit again waits again (waitAgain).
      if (l.guessed) this.rechecks.set(chatId, (this.rechecks.get(chatId) ?? 0) + 1);
      void this.goOn(chatId, l).catch((x) => console.warn(x));
    });
  }

  /**
   * A chat trying again after a guessed reset hit the limit again: it waits again (for the reset the agent says now,
   * else another guess), a few times, without asking; then it asks you. False when the chat isn't trying again.
   */
  private waitAgain(chatId: string, runId: string, limit: { resetsAt?: string }): boolean {
    const tries = this.rechecks.get(chatId);
    if (tries === undefined) return false;
    if (tries >= RECHECKS) return (void this.rechecks.delete(chatId), false);
    const run = runsView.rows(this.d.db).find((r) => r.runId === runId);
    const now = this.now();
    const until =
      limit.resetsAt ??
      (run?.harness ? usageView.agents(this.d.db, now)[run.harness]?.limitedUntil : null) ??
      new Date(now.getTime() + GUESS_MS).toISOString();
    const harness = run?.harness ?? "";
    const text = `Still at its limit — tries again at ${clockOf(until, now)}`;
    const data = { kind: "waiting", text, to: harness, until, ...(limit.resetsAt ? {} : { guessed: true }) };
    this.d.store.append({ chatId, runId: null, origin: "daemon", type: EV.chatHandoff, data });
    this.schedule(chatId, {
      from: harness,
      waitOn: harness,
      until,
      ...(limit.resetsAt ? {} : { guessed: true }),
    });
    return true;
  }

  /** The reset came: the chat goes on, on its own agent (its session resumes) or the one that reset first. */
  private async goOn(chatId: string, l: Wake): Promise<void> {
    if (l.waitOn !== l.from) return this.continueOn(chatId, l.from, l.waitOn, {});
    const request = this.request(this.d.store.read({ chatId }));
    await this.d.start({ chatId, harness: l.from, text: BACK }, { request });
  }

  /**
   * At ion's start: chats still waiting for a reset (nothing sent there since) wait again; one already past goes on a
   * few seconds after (once ion listens: its runs reach ion's tools).
   */
  private resume(): void {
    const soonest = new Date(this.now().getTime() + START_GRACE_MS).toISOString();
    for (const c of chatsView.list(this.d.db)) {
      const events = this.d.store.read({ chatId: c.chatId, types: [EV.chatHandoff, EV.messageSent] });
      const last = events.at(-1);
      const d = last?.data as { kind?: string; to?: string; until?: string; guessed?: true } | undefined;
      if (last?.type !== EV.chatHandoff || d?.kind !== "waiting" || !d.to || !d.until) continue;
      const from = runsView.rows(this.d.db).findLast((r) => r.chatId === c.chatId)?.harness ?? d.to;
      const until = d.until < soonest ? soonest : d.until;
      this.schedule(c.chatId, {
        from,
        waitOn: d.to,
        until,
        ...(d.guessed ? { guessed: true as const } : {}),
      });
    }
  }
}
