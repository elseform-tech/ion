import { DEFAULT_PROJECT, loadUserConfig } from "@ion/config";
import { type EffortLevel as Effort, EV, type HarnessInfo, type IonCard } from "@ion/schema";
import { defaultAgent } from "../adapters/registry.js";
import { UserError } from "../api/errors.js";
import type { Db, EventStore } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { needsView } from "../views/needs.js";
import { chiefPrompt, contextOf, parseRoute, type Route } from "./route.js";
import {
  parseProjectDecision,
  plainReport,
  projectContextOf,
  projectPrompt,
  reportOf,
  reportPrompt,
} from "./project.js";

const TIMEOUT_MS = 30_000;
const NO_MODEL = "I couldn't reach my model; try again.";

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

/** ion's own model failing goes to the daemon's log (its output): the chat only says it couldn't reach it. */
function logThink(why: string, agent: string | undefined): void {
  const who = agent ? `ion's model (${agent})` : "ion's model";
  console.error(`${who}: ${why.split("\n")[0]!.slice(0, 300)}`);
}

/** An answer ion couldn't read, logged; in debug mode (ION_DEBUG=1) with its start, to see why. */
function unreadable(said: string): void {
  const start = process.env.ION_DEBUG === "1" ? `: ${JSON.stringify(said.slice(0, 300))}` : "";
  logThink(`an answer ion couldn't read${start}`, undefined);
}

/** Without a project's own agent or a last one: the first ready (quota-friendly first). */
const firstOf = (ready: string[]) => defaultAgent(ready, null);

export type IonsDeps = {
  store: EventStore;
  db: Db;
  configFile: string;
  runs: { ask: Ask };
  /** ion's quick model (System 1): a prompt in, its last message out; `agent`: think on it instead of [ion] quick. */
  quick: (prompt: string, signal: AbortSignal, agent?: string) => Promise<string>;
  /** The agents and whether each is ready, to pick one for a project with none set. */
  agents?: () => Promise<HarnessInfo[]>;
};

/**
 * The ions: ion chief, and one per project (never `default`). A project's ion starts a thread (a chat marked
 * `by: "ion"`) for what you ask, and says how it ended. ion chief answers from what the daemon knows, or sends your
 * message on to project ions. Neither edits code. Each ion's chat is its events on "ion:<ionId>".
 */
export class Ions {
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

  /** Whatever goes wrong, the ion answers (else "Thinking" would stay): your mistake in its words, else NO_MODEL. */
  async message(ionId: string, text: string): Promise<void> {
    if (ionId !== "chief" && !this.projects().some((p) => p.id === ionId))
      throw new UserError(`Unknown ion: ${ionId}`);
    this.heard(ionId, text);
    try {
      if (ionId === "chief") await this.chief(text);
      else await this.project(ionId, text);
    } catch (e) {
      this.say(ionId, e instanceof UserError ? e.message : NO_MODEL);
    }
  }

  /** At the start: a message ion stopped before answering gets its answer now (else "Thinking" would stay). */
  answerUnanswered(): void {
    for (const ionId of ["chief", ...this.projects().map((p) => p.id)]) {
      const talk = this.d.store
        .read({ chatId: `ion:${ionId}` })
        .filter((e) => e.type === EV.ionHeard || e.type === EV.ionSaid);
      if (talk.at(-1)?.type === EV.ionHeard) this.say(ionId, NO_MODEL);
    }
  }

  /**
   * A project's ion thinks: answers itself, starts a thread for work (judged by your own words), or both. When its
   * model can't be reached, your own words start the thread.
   */
  private async project(projectId: string, text: string): Promise<void> {
    const p = loadUserConfig(this.d.configFile).config.projects.find((x) => x.id === projectId)!;
    const context = projectContextOf(p, chatsView.list(this.d.db), needsView.open(this.d.db));
    const said = await this.think(projectPrompt(text, context));
    const d = (said === null ? null : parseProjectDecision(said)) ?? { thread: text };
    if (!d.thread) return this.say(projectId, d.answer ?? "");
    const t = await this.thread(projectId, d.thread, { request: text });
    if ("why" in t) this.say(projectId, [d.answer, t.why].filter(Boolean).join(" "));
    else this.say(projectId, d.answer ?? "On it.", { kind: "threads", threads: [t] });
  }

  /**
   * A routine's time came (or you ran it now): its thread, titled by its name and briefed with its text (your own
   * words, so the judge reads them as your request), at its effort.
   */
  async routine(
    projectId: string,
    r: { name: string; text: string; effort?: Effort },
    by: "schedule" | "you",
  ): Promise<{ chatId: string; projectId: string } | { why: string }> {
    const t = await this.thread(projectId, r.text, { request: r.text, title: r.name, effort: r.effort });
    if ("why" in t) this.say(projectId, `${r.name} didn't start: ${t.why}`);
    else this.say(projectId, by === "you" ? "On it." : "On schedule.", { kind: "threads", threads: [t] });
    return t;
  }

  /**
   * Starts a thread in the project, on its ion's agent: the thread, or why it couldn't. `o.request` is what the
   * judge treats as your request: your own message (to ion chief), never a brief its model wrote. `o.title`: the
   * thread's title; `o.effort`: its effort, over the project's.
   */
  private async thread(
    projectId: string,
    text: string,
    o: { request?: string; title?: string; effort?: Effort } = {},
  ): Promise<{ chatId: string; projectId: string } | { why: string }> {
    const harness = await this.agentFor(projectId);
    try {
      // ion's threads always run in Auto: every action an agent takes there still goes through ion's checks.
      const args = {
        projectId,
        text,
        ...(harness ? { harness } : {}),
        ...this.brainOf(projectId, harness),
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

  /**
   * The project's model and effort (Settings). Effort always; the model on the agent it was picked for: the
   * project's own, or (none set) the one Settings showed, which is the one `agentFor` picks.
   */
  private brainOf(projectId: string, harness: string | undefined): { model?: string; effort?: Effort } {
    const p = loadUserConfig(this.d.configFile).config.projects.find((x) => x.id === projectId);
    if (!p) return {};
    const model = p.model && (!p.harness || p.harness === harness) ? p.model : undefined;
    return { ...(model ? { model } : {}), ...(p.effort ? { effort: p.effort } : {}) };
  }

  /** The project's own agent, else the one its last chat ran on, else the first ready (opencode, Grok, Codex, Claude). */
  private async agentFor(projectId: string): Promise<string | undefined> {
    const own = this.projects().find((p) => p.id === projectId)?.harness;
    if (own) return own;
    // The one it last ran on only while it's still ready (a key can expire); you set the project's own on purpose.
    const ok = await this.ready();
    const last = chatsView.lastAgent(this.d.db, projectId);
    if (last && (!this.d.agents || ok.includes(last))) return last;
    return firstOf(ok);
  }

  /** The agents installed and signed in. */
  private async ready(): Promise<string[]> {
    const all = (await this.d.agents?.().catch(() => [])) ?? [];
    return all.filter((h) => h.installed && h.signedIn).map((h) => h.id);
  }

  /** The agent ion thinks with: none (as [ion] quick says) when that one is ready, else the first ready. */
  private async quickAgent(): Promise<string | undefined> {
    if (!this.d.agents) return undefined;
    const ok = await this.ready();
    const set = loadUserConfig(this.d.configFile).config.ion.quick.split(":")[0]!;
    return ok.includes(set) ? undefined : firstOf(ok);
  }

  private async chief(text: string): Promise<void> {
    const r = await this.decide(text);
    if (!r) return this.say("chief", NO_MODEL);
    if (!("route" in r)) return this.say("chief", r.answer);
    const threads: { chatId: string; projectId: string }[] = [];
    const missed: string[] = [];
    for (const { projectId, brief } of r.route) {
      // The brief is ion chief's words, not yours.
      this.say(projectId, `From ion: ${brief.trim()}`);
      const t = await this.thread(projectId, brief, { request: text });
      if ("why" in t) missed.push(`Couldn't reach ${projectId}: ${t.why}`);
      else {
        threads.push(t);
        this.say(projectId, "On it.", { kind: "threads", threads: [t] });
      }
    }
    // The card shows the threads it started; the words say only what the card can't (a project it couldn't reach).
    const card: IonCard | undefined = threads.length ? { kind: "threads", threads } : undefined;
    this.say("chief", [r.answer, ...missed].filter(Boolean).join(" "), card);
  }

  /** ion chief's System 1: what to do with your message, or null when its model fails, is slow, or answers junk. */
  private async decide(text: string): Promise<Route | null> {
    // A project kept from ion chief (shareWithIon = false) gives it nothing to read and nothing to route to.
    const ids = this.projects()
      .filter((p) => p.shareWithIon !== false)
      .map((p) => p.id);
    const context = contextOf(ids, chatsView.list(this.d.db), needsView.open(this.d.db));
    const prompt = chiefPrompt(text, ids, context);
    // A model now and then answers in another shape than asked: ion asks once more before it gives up.
    for (let tries = 0; tries < 2; tries++) {
      const said = await this.think(prompt);
      if (said === null) return null;
      const r = parseRoute(said, ids);
      if (r) return r;
      unreadable(said);
    }
    return null;
  }

  /** ion's quick model on a prompt: its answer, or null when it fails or is slow. */
  private async think(prompt: string): Promise<string | null> {
    const agent = await this.quickAgent();
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A hard deadline: the model is told to stop, and ion doesn't wait past it even if it doesn't.
    const late = new Promise<null>((r) => {
      timer = setTimeout(() => {
        abort.abort();
        logThink(`no answer in ${TIMEOUT_MS / 1000} s`, agent);
        r(null);
      }, TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.d.quick(prompt, abort.signal, agent), late]);
    } catch (e) {
      // Its kind only: an agent's message can echo a provider's reply (debug mode logs it whole).
      const kind = e instanceof Error ? e.name : "an error";
      logThink(process.env.ION_DEBUG === "1" && e instanceof Error ? `${kind}: ${e.message}` : kind, agent);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** When one of an ion's threads ends, its ion tells you what came of it, in its own words. */
  watch(): void {
    this.d.store.onAppend((e) => {
      if (e.type !== EV.runFinished || !e.chatId) return;
      const chat = chatsView.list(this.d.db).find((c) => c.chatId === e.chatId);
      if (chat?.by !== "ion" || !chat.projectId) return;
      // The report takes a moment (ion's model); one that ends after ion stopped is dropped, never an error.
      this.report(chat.projectId, chat, (e.data as { status: string }).status).catch(() => {});
    });
  }

  /** Words only: the thread's line was shown when it started, and it updates as the thread runs. */
  private async report(projectId: string, chat: { chatId: string; title: string }, status: string) {
    const reply = this.lastReply(chat.chatId);
    const title = trimEnd(chat.title);
    const said = await this.think(reportPrompt(chat.title, reply, status));
    const text = reportOf(said) ?? plainReport(title, status, reply);
    this.say(projectId, text);
    // You asked ion chief: it passes the answer on, under the thread's line in its chat.
    if (this.chiefStarted(chat.chatId)) this.say("chief", text);
  }

  /** Whether ion chief started this thread (a threads card of its names it). */
  private chiefStarted(chatId: string): boolean {
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
