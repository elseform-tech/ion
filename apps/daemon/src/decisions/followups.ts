import { EV } from "@ion/schema";
import { UserError } from "../api/errors.js";
import type { EventStore } from "../store/index.js";

const BUSY = "This chat is already running";
/** A waiting answer that reads busy is tried again this often, this many times (then on the next run's end). */
const RETRY_MS = 250;
const RETRIES = 20;

/** Your answer on its way back into a chat: the message, what the judge treats as your request, and the agent. */
/** `shown`: what the chat shows as yours (your choice), when `text` is ion's wording for the agent. */
export type Message = {
  harness: string | null;
  text: string;
  request: string;
  shown?: string;
  /** The question this answers (its needId): the chat shows the answer under it. */
  answers?: string;
};
/** decisionId: the decision whose outcome the run is, if any (a one-off answer has none). */
type Pending = Message & { decisionId?: string };
export type Start = (chatId: string, m: Message) => Promise<string | null>;
type Ended = (chatId: string | null, decisionId: string, how: { ok: boolean; why?: string }) => void;

/**
 * Starts the runs that carry your answers. A busy chat keeps its answers in order and sends them one run at a
 * time as its runs end. The end of each such run is reported back (the decision's first outcome).
 */
export class FollowUps {
  private readonly queue = new Map<string, Pending[]>();
  /** Runs started by an answer → its decision. */
  private readonly runs = new Map<string, string>();

  constructor(
    store: EventStore,
    private readonly start: Start,
    private readonly ended: Ended,
  ) {
    store.onAppend((e) => {
      if (e.type !== EV.runFinished || !e.chatId) return;
      const decisionId = e.runId ? this.runs.get(e.runId) : undefined;
      const status = (e.data as { status: string }).status;
      if (decisionId && e.runId) {
        this.runs.delete(e.runId);
        if (status === "done" || status === "failed")
          this.ended(e.chatId, decisionId, { ok: status === "done" });
      }
      const chatId = e.chatId;
      if (this.queue.has(chatId)) queueMicrotask(() => void this.drain(chatId));
    });
  }

  /** Starts it now: its run id, or "busy" when the chat is running or has answers waiting. Other refusals throw. */
  async tryNow(chatId: string, m: Message): Promise<string | "busy"> {
    if (this.queue.get(chatId)?.length) return "busy";
    return this.attempt(chatId, m);
  }

  /** Sends it after what the chat already has waiting. */
  later(chatId: string, p: Pending): void {
    // One list per chat, changed in place: a send in flight sees what's added meanwhile.
    const list = this.queue.get(chatId) ?? [];
    list.push(p);
    this.queue.set(chatId, list);
  }

  /** Whether the chat has answers waiting to go in. */
  waiting(chatId: string): boolean {
    return (this.queue.get(chatId)?.length ?? 0) > 0;
  }

  started(runId: string, decisionId?: string): void {
    if (decisionId) this.runs.set(runId, decisionId);
  }

  private async attempt(chatId: string, m: Message): Promise<string | "busy"> {
    try {
      return (
        (await this.start(chatId, {
          harness: m.harness,
          text: m.text,
          request: m.request,
          ...(m.shown ? { shown: m.shown } : {}),
          ...(m.answers ? { answers: m.answers } : {}),
        })) ?? ""
      );
    } catch (e) {
      if (e instanceof UserError && e.message === BUSY) return "busy";
      throw e;
    }
  }

  private readonly tries = new Map<string, number>();

  private retry(chatId: string): void {
    const n = (this.tries.get(chatId) ?? 0) + 1;
    if (n > RETRIES) return void this.tries.delete(chatId);
    this.tries.set(chatId, n);
    setTimeout(() => void this.drain(chatId), RETRY_MS).unref?.();
  }

  /** The chat's run ended: send its next waiting answer (one; the run it starts makes the chat busy again). */
  /** Chats whose next answer is being sent: one send at a time, so a retry and a run's end can't both send it. */
  private readonly draining = new Set<string>();

  /** Chats asked to drain while one was draining: they drain again after it, so no request is lost. */
  private readonly again = new Set<string>();

  private async drain(chatId: string): Promise<void> {
    if (this.draining.has(chatId)) return void this.again.add(chatId);
    this.draining.add(chatId);
    try {
      // One answer, then the next while there is one (it usually reads busy: its run waits for this one's end).
      while (await this.sendNext(chatId));
    } finally {
      this.draining.delete(chatId);
      if (this.again.delete(chatId) && this.queue.get(chatId)?.length)
        queueMicrotask(() => void this.drain(chatId));
    }
  }

  /** Sends the chat's next waiting answer; true when another waits to be tried now. */
  private async sendNext(chatId: string): Promise<boolean> {
    const list = this.queue.get(chatId) ?? [];
    const next = list[0];
    if (!next) {
      this.queue.delete(chatId);
      return false;
    }
    try {
      const r = await this.attempt(chatId, next);
      // The run that just ended can still count for a moment: try again shortly, a few times. A run that really
      // is going ends with run.finished, which drains again anyway.
      if (r === "busy") {
        this.retry(chatId);
        return false;
      }
      if (r) this.started(r, next.decisionId);
    } catch (e) {
      if (next.decisionId)
        this.ended(chatId, next.decisionId, {
          ok: false,
          why: `Couldn't send your answer: ${(e as Error).message}`,
        });
    }
    this.tries.delete(chatId);
    // Removed by identity from the live list (it may have grown while this one was sent).
    const live = this.queue.get(chatId) ?? [];
    const at = live.indexOf(next);
    if (at >= 0) live.splice(at, 1);
    if (live.length === 0) this.queue.delete(chatId);
    return live.length > 0;
  }
}
