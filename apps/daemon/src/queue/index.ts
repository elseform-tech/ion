import { randomUUID } from "node:crypto";
import {
  type AskBrain,
  type Commands,
  EV,
  type EventType,
  type QueuedInfo,
  type QueueTarget,
} from "@ion/schema";
import { UserError } from "../api/errors.js";
import type { Db, EventStore } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { needsView } from "../views/needs.js";
import { type QueuedRow, queueView } from "../views/queue.js";

/** At most this many wait per chat or ion. */
const MAX_WAITING = 10;
/** What ask says when the chat is running: the message just waits for the run's end. */
const BUSY = "This chat is already running";

export type QueueDeps = {
  store: EventStore;
  db: Db;
  /**
   * A chat's runs: a message goes out as ask does; whether it's working; Esc twice; when its run ends; whether your
   * answers to its questions wait to go in (they go first); closing its open questions (Send now goes anyway).
   */
  chats: {
    ask(args: Commands["ask"]["args"]): unknown;
    busy(chatId: string): boolean;
    stop(chatId: string): Promise<void>;
    onEnded(fn: (chatId: string) => void): void;
    answersWaiting(chatId: string): boolean;
    dropQuestions(chatId: string): void;
  };
  /** The ions: whether one exists; your message to one; whether it's thinking; Esc twice; when its turn ends. */
  ions: {
    knows(ionId: string): boolean;
    message(ionId: string, text: string): Promise<void>;
    busy(ionId: string): boolean;
    stopTurn(ionId: string): boolean;
    onTurnEnd(fn: (ionId: string) => void): void;
  };
};

/** One key per chat or ion. */
const keyOf = (to: QueueTarget): string => ("chatId" in to ? `chat:${to.chatId}` : `ion:${to.ionId}`);
/** The events of a queued message go on its chat's (or ion's chat's) own stream, so the app hears of them there. */
const streamOf = (to: QueueTarget): string => ("chatId" in to ? to.chatId : `ion:${to.ionId}`);

/**
 * Your next messages to a chat or an ion, while it works (Plan 16). Each waits as events (so it survives ion
 * stopping) and goes out, oldest first, when the chat's run ends (however it ended) or the ion's turn does: one at
 * a time, with the brain picked when it was queued. Send now stops the work and goes next. A chat's queue waits
 * while the agent's question is open and while your answers wait to go in; one that couldn't go out says why and
 * holds its queue until you send it now, edit it or remove it.
 */
export class PromptQueue {
  /** Messages going out now (until the chat's run is queued, or the ion has heard it): no longer yours to edit. */
  private readonly sending = new Set<string>();
  /** Chats and ions with a message going out now: only one at a time. */
  private readonly busyKeys = new Set<string>();
  /** The message Send now picked to go next, per chat or ion. */
  private readonly next = new Map<string, string>();
  /** Send now while one was going out: the work it starts is stopped once it has started. */
  private readonly stopAfter = new Set<string>();

  constructor(private readonly d: QueueDeps) {
    const drain = (to: QueueTarget) => void this.drain(to).catch(() => {});
    d.chats.onEnded((chatId) => drain({ chatId }));
    d.ions.onTurnEnd((ionId) => {
      this.unhold({ ionId });
      drain({ ionId });
    });
    d.store.onAppend((e) => {
      const chatId = e.chatId;
      if (!chatId || chatId.startsWith("ion:")) return;
      // A chat archived with messages waiting: they go with it.
      if (e.type === EV.chatArchived) this.clear({ chatId });
      // A run there went well: a failed send's hold lifts (the run's end then drains).
      else if (e.type === EV.runFinished && (e.data as { status?: unknown }).status === "done")
        this.unhold({ chatId });
      // A question answered (or closed): the queue goes on, after your answer has gone in or taken its turn.
      else if (e.type === EV.needResolved) queueMicrotask(() => drain({ chatId }));
    });
  }

  list(to: QueueTarget): QueuedInfo[] {
    const held = "chatId" in to && this.waitsForAnswer(to.chatId) ? { held: "answer" as const } : {};
    return queueView.waiting(this.d.db, to).map(({ queueId, text, brain, addedAt, why }) => ({
      ...{ queueId, text, brain, addedAt },
      ...(why ? { why } : {}),
      ...held,
    }));
  }

  /** The chat's agent asked you something, or your answers wait to go in: its queue waits for them. */
  private waitsForAnswer(chatId: string): boolean {
    return this.d.chats.answersWaiting(chatId) || this.asking(chatId);
  }

  private asking(chatId: string): boolean {
    return needsView.open(this.d.db, chatId, true).some((n) => n.kind === "ask");
  }

  /** Queues a message; when nothing is working it goes out at once (the work ended as you queued it). */
  add(to: QueueTarget, text: string, brain: AskBrain): string {
    const t = text.trim();
    if (!t) throw new UserError("Say what to do");
    this.check(to);
    if (queueView.waiting(this.d.db, to).length >= MAX_WAITING)
      throw new UserError("That's 10 waiting already");
    const queueId = `queue_${randomUUID()}`;
    this.append(to, EV.queueAdded, { queueId, to, text: t, brain: brainOf(brain) });
    this.wake(to);
    return queueId;
  }

  remove(queueId: string): void {
    const q = this.waiting(queueId);
    this.append(q.to, EV.queueRemoved, { queueId });
    this.unhold(q.to);
    this.wake(q.to);
  }

  /** Edit: its text back for the box, and out of the queue; refused once it went (or is going) out. */
  take(queueId: string): { text: string } {
    const q = this.waiting(queueId);
    this.append(q.to, EV.queueRemoved, { queueId });
    this.unhold(q.to);
    this.wake(q.to);
    return { text: q.text };
  }

  /** Sends it next: the chat's run (or the ion's turn) stops, and it goes when the work has ended. */
  async sendNow(queueId: string): Promise<void> {
    const q = this.waiting(queueId);
    const key = keyOf(q.to);
    this.next.set(key, queueId);
    if (this.busyKeys.has(key)) return void this.stopAfter.add(key);
    if (this.working(q.to)) return this.stop(q.to);
    return this.drain(q.to);
  }

  /** At the start: what waits for a chat or an ion that isn't working goes out (ion stopped while it waited). */
  resume(): void {
    for (const to of queueView.targets(this.d.db)) this.wake(to);
  }

  /** Everything waiting for a chat or an ion goes (its chat archived, its project removed). */
  clear(to: QueueTarget): void {
    for (const q of queueView.waiting(this.d.db, to))
      this.append(to, EV.queueRemoved, { queueId: q.queueId });
    this.next.delete(keyOf(to));
  }

  /** Sends the next message (Send now's pick, else the oldest) when the chat or ion is free; one at a time. */
  async drain(to: QueueTarget): Promise<void> {
    const key = keyOf(to);
    if (this.busyKeys.has(key) || this.working(to)) return;
    const q = this.ready(to);
    if (!q) return;
    this.busyKeys.add(key);
    this.sending.add(q.queueId);
    try {
      await this.send(q);
    } catch (e) {
      // A run that just started meanwhile: it waits for that run's end. Anything else: it says why, and holds.
      if (!(e instanceof UserError && e.message === BUSY)) this.failed(q, e);
    } finally {
      this.sending.delete(q.queueId);
      this.busyKeys.delete(key);
    }
    if (this.stopAfter.delete(key)) await this.stop(to);
  }

  private wake(to: QueueTarget): void {
    if (!this.working(to)) void this.drain(to).catch(() => {});
  }

  private stop(to: QueueTarget): Promise<void> {
    if ("chatId" in to) return this.d.chats.stop(to.chatId);
    this.d.ions.stopTurn(to.ionId);
    return Promise.resolve();
  }

  /**
   * The message to send now, or none: an ion that's gone has its queue cleared; a chat waits for your answers, for
   * its open question and after a failed send, unless you picked this one with Send now (its question is closed).
   */
  private ready(to: QueueTarget): QueuedRow | null {
    if ("ionId" in to && !this.d.ions.knows(to.ionId)) {
      this.clear(to);
      return null;
    }
    const waiting = queueView.waiting(this.d.db, to);
    const chosen = waiting.find((q) => q.queueId === this.next.get(keyOf(to)));
    const q = chosen ?? waiting[0];
    return q && !this.held(to, waiting, chosen !== undefined) ? q : null;
  }

  /** Whether the queue waits (see ready); a chat's open question is closed when Send now goes anyway. */
  private held(to: QueueTarget, waiting: QueuedRow[], chosen: boolean): boolean {
    const failed = !chosen && waiting.some((w) => w.why);
    if (!("chatId" in to)) return failed;
    if (this.d.chats.answersWaiting(to.chatId)) return true;
    const asking = this.asking(to.chatId);
    if (failed || (asking && !chosen)) return true;
    if (asking) this.d.chats.dropQuestions(to.chatId);
    return false;
  }

  /**
   * A chat: its next run, on the brain picked when it was queued (marked sent once the run is queued; if it can't
   * start, it stays waiting). An ion: heard at once, its turn goes on without holding the queue.
   */
  private async send(q: QueuedRow): Promise<void> {
    const key = keyOf(q.to);
    if ("chatId" in q.to) {
      await this.d.chats.ask({ ...q.brain, chatId: q.to.chatId, text: q.text });
      this.sent(q, key);
      return;
    }
    this.sent(q, key);
    void this.d.ions.message(q.to.ionId, q.text).catch(() => {});
  }

  private sent(q: QueuedRow, key: string): void {
    if (this.next.get(key) === q.queueId) this.next.delete(key);
    this.append(q.to, EV.queueSent, { queueId: q.queueId });
    this.unhold(q.to);
  }

  /** Things moved (a send went out, you changed the queue, a run went well): a failed send no longer holds it. */
  private unhold(to: QueueTarget): void {
    for (const q of queueView.waiting(this.d.db, to))
      if (q.why) this.append(to, EV.queueFailed, { queueId: q.queueId, why: null });
  }

  private failed(q: QueuedRow, e: unknown): void {
    const key = keyOf(q.to);
    if (this.next.get(key) === q.queueId) this.next.delete(key);
    // Only ion's own words show; anything else (a path, SQLite, git) is logged, and said plainly.
    const why = e instanceof UserError ? e.message : "Couldn't send it";
    if (!(e instanceof UserError)) console.error(`ion couldn't send a queued message: ${String(e)}`);
    this.append(q.to, EV.queueFailed, { queueId: q.queueId, why });
  }

  private working(to: QueueTarget): boolean {
    return "chatId" in to ? this.d.chats.busy(to.chatId) : this.d.ions.busy(to.ionId);
  }

  /** A queued message still waiting (not going out now). */
  private waiting(queueId: string): QueuedRow {
    const q = queueView.find(this.d.db, queueId);
    if (!q) throw new UserError("That message isn't queued");
    if (q.state === "sent" || this.sending.has(queueId)) throw new UserError("Already sent");
    if (q.state !== "waiting") throw new UserError("That message isn't queued");
    return q;
  }

  /** Where it goes: a chat of yours that isn't archived, or an ion. */
  private check(to: QueueTarget): void {
    if ("ionId" in to) {
      if (!this.d.ions.knows(to.ionId)) throw new UserError(`Unknown ion: ${to.ionId}`);
      return;
    }
    const chat = chatsView.list(this.d.db).find((c) => c.chatId === to.chatId);
    if (!chat) throw new UserError(`Unknown chat: ${to.chatId}`);
    if (chat.archived) throw new UserError("That chat is archived");
  }

  private append(to: QueueTarget, type: EventType, data: Record<string, unknown>): void {
    this.d.store.append({ chatId: streamOf(to), runId: null, origin: "daemon", type, data });
  }
}

const EFFORTS: readonly string[] = ["low", "medium", "high", "max"];

/** Only what ask takes from the message box (its agent, model, effort and access), each only when it's one. */
function brainOf(x: unknown): AskBrain {
  const b = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const effort = EFFORTS.includes(String(b.effort)) ? (b.effort as AskBrain["effort"]) : undefined;
  const access = b.access === "auto" || b.access === "full" ? b.access : undefined;
  const all = { harness: text(b.harness), model: text(b.model), effort, access };
  return Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined)) as AskBrain;
}

/** A queue's target from a command's arguments: a chat or an ion. */
export function targetOf(x: unknown): QueueTarget {
  const t = (x ?? {}) as { chatId?: unknown; ionId?: unknown };
  if (typeof t.chatId === "string" && t.chatId) return { chatId: t.chatId };
  if (typeof t.ionId === "string" && t.ionId) return { ionId: t.ionId };
  throw new UserError("Pick a chat or an ion");
}
