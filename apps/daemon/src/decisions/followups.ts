import { EV } from "@ion/schema";
import { UserError } from "../api/errors.js";
import type { EventStore } from "../store/index.js";

const BUSY = "This chat is already running";

/** Your answer on its way back into a chat: the message, what the judge treats as your request, and the agent. */
/** `shown`: what the chat shows as yours (your choice), when `text` is ion's wording for the agent. */
export type Message = { harness: string | null; text: string; request: string; shown?: string };
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
    this.queue.set(chatId, [...(this.queue.get(chatId) ?? []), p]);
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
        })) ?? ""
      );
    } catch (e) {
      if (e instanceof UserError && e.message === BUSY) return "busy";
      throw e;
    }
  }

  /** The chat's run ended: send its next waiting answer (one; the run it starts makes the chat busy again). */
  private async drain(chatId: string): Promise<void> {
    const list = this.queue.get(chatId) ?? [];
    const next = list[0];
    if (!next) return void this.queue.delete(chatId);
    try {
      const r = await this.attempt(chatId, next);
      if (r === "busy") return;
      if (r) this.started(r, next.decisionId);
    } catch (e) {
      if (next.decisionId)
        this.ended(chatId, next.decisionId, {
          ok: false,
          why: `Couldn't send your answer: ${(e as Error).message}`,
        });
    }
    list.shift();
    if (list.length === 0) this.queue.delete(chatId);
    else if (this.queue.get(chatId) === list) queueMicrotask(() => void this.drain(chatId));
  }
}
