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
import { type QueuedRow, queueView } from "../views/queue.js";

/** At most this many wait per chat or ion. */
const MAX_WAITING = 10;

export type QueueDeps = {
  store: EventStore;
  db: Db;
  /** A chat's runs: a message goes out as ask does; whether it's working; Esc twice; when its run ends. */
  chats: {
    ask(args: Commands["ask"]["args"]): unknown;
    busy(chatId: string): boolean;
    stop(chatId: string): Promise<void>;
    onEnded(fn: (chatId: string) => void): void;
  };
  /** The ions: your message to one; whether it's thinking; Esc twice; when its turn ends. */
  ions: {
    knows(ionId: string): boolean;
    message(ionId: string, text: string): Promise<void>;
    busy(ionId: string): boolean;
    stopTurn(ionId: string): void;
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
 * a time, with the brain picked when it was queued. Send now stops the work and goes next.
 */
export class PromptQueue {
  /** Messages going out now (until the chat's run is queued, or the ion has heard it): no longer yours to edit. */
  private readonly sending = new Set<string>();
  /** Chats and ions with a message going out now: only one at a time. */
  private readonly busyKeys = new Set<string>();
  /** The message Send now picked to go next, per chat or ion. */
  private readonly next = new Map<string, string>();

  constructor(private readonly d: QueueDeps) {
    const drain = (to: QueueTarget) => void this.drain(to).catch(() => {});
    d.chats.onEnded((chatId) => drain({ chatId }));
    d.ions.onTurnEnd((ionId) => drain({ ionId }));
    // A chat archived with messages waiting: they go with it.
    d.store.onAppend((e) => {
      if (e.type === EV.chatArchived && e.chatId) this.clear({ chatId: e.chatId });
    });
  }

  list(to: QueueTarget): QueuedInfo[] {
    return queueView.waiting(this.d.db, to).map(({ queueId, text, brain, addedAt }) => ({
      queueId,
      text,
      brain,
      addedAt,
    }));
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
    if (!this.working(to)) void this.drain(to).catch(() => {});
    return queueId;
  }

  remove(queueId: string): void {
    const q = this.waiting(queueId);
    this.append(q.to, EV.queueRemoved, { queueId });
  }

  /** Edit: its text back for the box, and out of the queue; refused once it went (or is going) out. */
  take(queueId: string): { text: string } {
    const q = this.waiting(queueId);
    this.append(q.to, EV.queueRemoved, { queueId });
    return { text: q.text };
  }

  /** Sends it next: the chat's run (or the ion's turn) stops, and it goes when the work has ended. */
  async sendNow(queueId: string): Promise<void> {
    const q = this.waiting(queueId);
    const key = keyOf(q.to);
    this.next.set(key, queueId);
    if (!this.working(q.to)) return this.drain(q.to);
    if ("chatId" in q.to) await this.d.chats.stop(q.to.chatId);
    else this.d.ions.stopTurn(q.to.ionId);
  }

  /** At the start: what waits for a chat or an ion that isn't working goes out (ion stopped while it waited). */
  resume(): void {
    for (const to of queueView.targets(this.d.db)) void this.drain(to).catch(() => {});
  }

  /** Sends the next message (Send now's pick, else the oldest) when the chat or ion is free; one at a time. */
  async drain(to: QueueTarget): Promise<void> {
    const key = keyOf(to);
    if (this.busyKeys.has(key) || this.working(to)) return;
    const q = this.pick(to);
    if (!q) return;
    this.busyKeys.add(key);
    this.sending.add(q.queueId);
    try {
      await this.send(q);
    } finally {
      this.sending.delete(q.queueId);
      this.busyKeys.delete(key);
    }
  }

  private pick(to: QueueTarget): QueuedRow | undefined {
    const waiting = queueView.waiting(this.d.db, to);
    const chosen = this.next.get(keyOf(to));
    return waiting.find((q) => q.queueId === chosen) ?? waiting[0];
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

  private clear(to: QueueTarget): void {
    for (const q of queueView.waiting(this.d.db, to))
      this.append(to, EV.queueRemoved, { queueId: q.queueId });
    this.next.delete(keyOf(to));
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
