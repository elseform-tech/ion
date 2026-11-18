import { DEFAULT_PROJECT, loadUserConfig } from "@ion/config";
import { EV, type HarnessInfo, type IonCard } from "@ion/schema";
import { UserError } from "../api/errors.js";
import type { Db, EventStore } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { needsView } from "../views/needs.js";
import { chiefPrompt, contextOf, parseRoute, type Route } from "./route.js";

const TIMEOUT_MS = 30_000;
const NO_MODEL = "I couldn't reach my model; try again.";

type Ask = (
  args: { projectId: string; text: string; harness?: string; access: "auto" },
  opts: { by: "ion"; request?: string },
) => Promise<{ chatId: string; runId: string }>;

/** Without a project's own agent or a last one: the first ready of these (quota-friendly first), else any. */
const PREFERRED = ["opencode", "grok-build", "claude-code"];

export type IonsDeps = {
  store: EventStore;
  db: Db;
  configFile: string;
  runs: { ask: Ask };
  /** ion's quick model (System 1): a prompt in, its last message out. */
  quick: (prompt: string, signal: AbortSignal) => Promise<string>;
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

  async message(ionId: string, text: string): Promise<void> {
    if (ionId !== "chief" && !this.projects().some((p) => p.id === ionId))
      throw new UserError(`Unknown ion: ${ionId}`);
    this.heard(ionId, text);
    if (ionId === "chief") return this.chief(text);
    const r = await this.thread(ionId, text);
    if ("why" in r) this.say(ionId, r.why);
    else this.say(ionId, "On it.", { kind: "threads", threads: [r] });
  }

  /** Starts a thread in the project, on its ion's agent: the thread, or why it couldn't. */
  /**
   * Starts a thread in the project, on its ion's agent: the thread, or why it couldn't. `request` is what the judge
   * treats as your request: your own message (to ion chief), never a brief its model wrote.
   */
  private async thread(
    projectId: string,
    text: string,
    request?: string,
  ): Promise<{ chatId: string; projectId: string } | { why: string }> {
    const harness = await this.agentFor(projectId);
    try {
      // ion's threads always run in Auto: every action an agent takes there still goes through ion's checks.
      const args = { projectId, text, ...(harness ? { harness } : {}), access: "auto" as const };
      const { chatId } = await this.d.runs.ask(args, { by: "ion", ...(request ? { request } : {}) });
      return { chatId, projectId };
    } catch (e) {
      if (e instanceof UserError) return { why: e.message };
      throw e;
    }
  }

  /** The project's own agent, else the one its last chat ran on, else the first ready (opencode, Grok, Claude). */
  private async agentFor(projectId: string): Promise<string | undefined> {
    const own = this.projects().find((p) => p.id === projectId)?.harness;
    if (own) return own;
    const last = chatsView
      .list(this.d.db)
      .filter((c) => c.projectId === projectId)
      .sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""))
      .map((c) => chatsView.session(this.d.db, c.chatId)?.harness)
      .find(Boolean);
    if (last) return last;
    const ready = (await this.d.agents?.().catch(() => [])) ?? [];
    const ok = ready.filter((h) => h.installed && h.signedIn).map((h) => h.id);
    return PREFERRED.find((id) => ok.includes(id)) ?? ok[0];
  }

  private async chief(text: string): Promise<void> {
    const r = await this.decide(text);
    if (!r) return this.say("chief", NO_MODEL);
    if ("answer" in r) return this.say("chief", r.answer);
    const threads: { chatId: string; projectId: string }[] = [];
    const missed: string[] = [];
    for (const { projectId, brief } of r.route) {
      // The brief is ion chief's words, not yours.
      this.say(projectId, `ion asked: ${JSON.stringify(brief)}`);
      const t = await this.thread(projectId, brief, text);
      if ("why" in t) missed.push(`Couldn't reach ${projectId}: ${t.why}`);
      else {
        threads.push(t);
        this.say(projectId, "On it.", { kind: "threads", threads: [t] });
      }
    }
    // The card shows the threads it started; the words say only what the card can't (a project it couldn't reach).
    const card: IonCard | undefined = threads.length ? { kind: "threads", threads } : undefined;
    this.say("chief", missed.join(" "), card);
  }

  /** ion chief's System 1: what to do with your message, or null when its model fails, is slow, or answers junk. */
  private async decide(text: string): Promise<Route | null> {
    // A project kept from ion chief (shareWithIon = false) gives it nothing to read and nothing to route to.
    const ids = this.projects()
      .filter((p) => p.shareWithIon !== false)
      .map((p) => p.id);
    const context = contextOf(ids, chatsView.list(this.d.db), needsView.open(this.d.db));
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A hard deadline: the model is told to stop, and ion doesn't wait past it even if it doesn't.
    const late = new Promise<null>((r) => {
      timer = setTimeout(() => {
        abort.abort();
        r(null);
      }, TIMEOUT_MS);
    });
    try {
      const said = await Promise.race([this.d.quick(chiefPrompt(text, ids, context), abort.signal), late]);
      return said === null ? null : parseRoute(said, ids);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** When one of an ion's threads ends, its ion says so: title, how it ended, and the start of the reply. */
  watch(): void {
    this.d.store.onAppend((e) => {
      if (e.type !== EV.runFinished || !e.chatId) return;
      const chat = chatsView.list(this.d.db).find((c) => c.chatId === e.chatId);
      if (chat?.by !== "ion" || !chat.projectId) return;
      const status = (e.data as { status: string }).status;
      const line = [`${chat.title}: ${status}.`, chat.preview].filter(Boolean).join(" ");
      this.say(chat.projectId, line, {
        kind: "threads",
        threads: [{ chatId: chat.chatId, projectId: chat.projectId }],
      });
    });
  }
}
