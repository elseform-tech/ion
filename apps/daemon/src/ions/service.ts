import { DEFAULT_PROJECT, loadUserConfig } from "@ion/config";
import { type EffortLevel as Effort, EV, type HarnessInfo, type IonCard } from "@ion/schema";
import { UserError } from "../api/errors.js";
import type { Db, EventStore } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { brainOf, projectAgent } from "./brain.js";
import { plainReport } from "./project.js";
import { type IonTurns, NO_AGENT, TOO_LONG } from "./turn.js";

type Ask = (
  args: {
    projectId: string;
    text: string;
    harness?: string;
    model?: string;
    effort?: Effort;
    access: "auto";
  },
  opts: { by: "ion"; request?: string; title?: string },
) => Promise<{ chatId: string; runId: string }>;

/** A title without its closing stops or spaces ("Fix the cart." → "Fix the cart"), to quote it in a sentence. */
function trimEnd(title: string): string {
  let end = title.length;
  while (end > 0 && ".!?… ".includes(title[end - 1]!)) end--;
  return title.slice(0, end);
}

export type IonsDeps = {
  store: EventStore;
  db: Db;
  configFile: string;
  runs: { ask: Ask };
  /** An ion's turn: a session of its own agent with ion's tools; its reply and the threads it started. */
  turns: Pick<IonTurns, "turn">;
  /** The agents and whether each is ready, to pick one for a project with none set. */
  agents?: () => Promise<HarnessInfo[]>;
};

type Thread = { chatId: string; projectId: string };

/**
 * The ions: ion chief, and one per project (never `default`). Each message to an ion is a turn of its own agent
 * session (IonTurns) with ion's tools: it answers, and starts threads (chats marked `by: "ion"`) for work. When a
 * thread ends, its ion says what came of it. No ion edits code. Each ion's chat is its events on "ion:<ionId>".
 */
export class Ions {
  /** Threads ion chief started while ion runs (its card is said only when its turn ends, maybe after the thread). */
  private readonly fromChief = new Set<string>();
  /** ion chief's answer being made: what came of a thread it started is passed on after it, never before. */
  private chiefAnswering: Promise<void> = Promise.resolve();

  constructor(private readonly d: IonsDeps) {}

  private projects(): { id: string; harness?: string; shareWithIon?: boolean }[] {
    return loadUserConfig(this.d.configFile).config.projects.filter((p) => p.id !== DEFAULT_PROJECT);
  }

  private say(ionId: string, text: string, card?: IonCard): void {
    this.d.store.append({
      chatId: `ion:${ionId}`,
      runId: null,
      origin: "daemon",
      type: EV.ionSaid,
      data: { text, ...(card ? { card } : {}) },
    });
  }

  private heard(ionId: string, text: string): void {
    this.d.store.append({
      chatId: `ion:${ionId}`,
      runId: null,
      origin: "daemon",
      type: EV.ionHeard,
      data: { text },
    });
  }

  /**
   * Your message: a turn of the ion's agent; its reply and the threads it started are one message. Whatever goes
   * wrong, the ion answers (else "Thinking" would stay): your mistake in its words, else NO_AGENT.
   */
  async message(ionId: string, text: string): Promise<void> {
    if (ionId !== "chief" && !this.projects().some((p) => p.id === ionId))
      throw new UserError(`Unknown ion: ${ionId}`);
    this.heard(ionId, text);
    const answering = this.answer(ionId, text);
    if (ionId === "chief") this.chiefAnswering = answering;
    await answering;
  }

  private async answer(ionId: string, text: string): Promise<void> {
    try {
      const { reply, threads } = await this.d.turns.turn(ionId, text);
      this.say(ionId, reply, threadsCard(threads));
    } catch (e) {
      this.say(ionId, e instanceof UserError ? e.message : NO_AGENT);
    }
  }

  /** At the start: a message ion stopped before answering gets its answer now (else "Thinking" would stay). */
  answerUnanswered(): void {
    for (const ionId of ["chief", ...this.projects().map((p) => p.id)]) {
      const talk = this.d.store
        .read({ chatId: `ion:${ionId}` })
        .filter((e) => e.type === EV.ionHeard || e.type === EV.ionSaid);
      if (talk.at(-1)?.type === EV.ionHeard) this.say(ionId, NO_AGENT);
    }
  }

  /**
   * An ion's turn starts a thread (its start_thread tool): the thread's chat, or why it couldn't. `turn.request` is
   * your own message, what the judge reads as your request. From ion chief, the project's ion says the brief (ion
   * chief's words, not yours) and shows the thread's line; a project's own ion shows it with its reply.
   */
  async startThread(
    projectId: string,
    brief: string,
    turn: { ionId: string; request: string },
  ): Promise<{ chatId: string } | { why: string }> {
    const chief = turn.ionId === "chief";
    if (chief) this.say(projectId, `From ion: ${brief.trim()}`);
    const t = await this.thread(projectId, brief, { request: turn.request });
    if ("why" in t) return t;
    if (chief) {
      this.fromChief.add(t.chatId);
      this.say(projectId, "On it.", threadsCard([t]));
    }
    return { chatId: t.chatId };
  }

  /**
   * A routine's time came (or you ran it now): its thread, titled by its name and briefed with its text (your own
   * words, so the judge reads them as your request), at its effort. It starts directly: no turn, nothing to decide.
   */
  async routine(
    projectId: string,
    r: { name: string; text: string; effort?: Effort },
    by: "schedule" | "you",
  ): Promise<Thread | { why: string }> {
    const t = await this.thread(projectId, r.text, { request: r.text, title: r.name, effort: r.effort });
    if ("why" in t) this.say(projectId, `${r.name} didn't start: ${t.why}`);
    else this.say(projectId, by === "you" ? "On it." : "On schedule.", threadsCard([t]));
    return t;
  }

  /**
   * Starts a thread in the project, on its ion's agent: the thread, or why it couldn't. `o.request` is what the
   * judge treats as your request: your own message, never a brief an ion's agent wrote. `o.title`: the thread's
   * title; `o.effort`: its effort, over the project's.
   */
  private async thread(
    projectId: string,
    text: string,
    o: { request?: string; title?: string; effort?: Effort } = {},
  ): Promise<Thread | { why: string }> {
    const harness = await projectAgent(this.d, projectId);
    try {
      // ion's threads always run in Auto: every action an agent takes there still goes through ion's checks.
      const args = {
        projectId,
        text,
        ...(harness ? { harness } : {}),
        ...brainOf(this.d.configFile, projectId, harness),
        ...(o.effort ? { effort: o.effort } : {}),
        access: "auto" as const,
      };
      const opts = { by: "ion" as const, ...(o.request ? { request: o.request } : {}) };
      const { chatId } = await this.d.runs.ask(args, o.title ? { ...opts, title: o.title } : opts);
      return { chatId, projectId };
    } catch (e) {
      if (e instanceof UserError) return { why: e.message };
      throw e;
    }
  }

  /** When one of an ion's threads ends, its ion tells you what came of it, in its own words. */
  watch(): void {
    this.d.store.onAppend((e) => {
      if (e.type !== EV.runFinished || !e.chatId) return;
      const chat = chatsView.list(this.d.db).find((c) => c.chatId === e.chatId);
      if (chat?.by !== "ion" || !chat.projectId) return;
      // The report takes a turn; one that ends after ion stopped is dropped, never an error.
      this.report(chat.projectId, chat, (e.data as { status: string }).status).catch(() => {});
    });
  }

  /**
   * A turn of the project's ion says what came of the thread (it reads the thread with its tools); without its
   * agent, the thread agent's own reply. You asked ion chief: it passes its project ion's words on, under the
   * thread's line in its chat (repeated, not a turn of its own: the same words, no second session).
   */
  private async report(projectId: string, chat: { chatId: string; title: string }, status: string) {
    const title = trimEnd(chat.title);
    const r = await this.d.turns
      .turn(projectId, `Thread ${title} ended: ${status}. Tell the user what came of it.`)
      .catch(() => null);
    const failed = !r || r.reply === NO_AGENT || r.reply === TOO_LONG;
    const text = failed ? plainReport(title, status, this.lastReply(chat.chatId)) : r.reply;
    this.say(projectId, text, r ? threadsCard(r.threads) : undefined);
    if (!this.chiefStarted(chat.chatId)) return;
    await this.chiefAnswering;
    this.say("chief", text);
  }

  /** Whether ion chief started this thread (while ion runs, or a threads card of its names it). */
  private chiefStarted(chatId: string): boolean {
    if (this.fromChief.has(chatId)) return true;
    return this.d.store.read({ chatId: "ion:chief" }).some((e) => {
      const card = e.type === EV.ionSaid ? (e.data as { card?: IonCard }).card : undefined;
      return card?.kind === "threads" && card.threads.some((t) => t.chatId === chatId);
    });
  }

  /** The agent's last whole message in a chat ("" when it said nothing). */
  private lastReply(chatId: string): string {
    const e = this.d.store
      .read({ chatId })
      .findLast((x) => x.type === EV.messageCompleted && x.origin === "adapter");
    return e ? String((e.data as { text?: unknown }).text ?? "") : "";
  }
}

/** The threads a reply carries, as its card (none when it started none). */
function threadsCard(threads: Thread[]): IonCard | undefined {
  return threads.length ? { kind: "threads", threads } : undefined;
}
