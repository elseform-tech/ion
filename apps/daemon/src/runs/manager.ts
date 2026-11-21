import { randomUUID } from "node:crypto";
import { availableParallelism, homedir } from "node:os";
import {
  type ApprovalRequest,
  type GateCall,
  projectRoots,
  ResumeFailed,
  type Session,
} from "@ion/adapter-kit";
import { loadUserConfig } from "@ion/config";
import { type Commands, EV } from "@ion/schema";
import { getHarness, type HarnessEntry } from "../adapters/registry.js";
import { type Chat, chatCreated, chatFor, Readiness } from "./ready.js";
import { UserError } from "../api/errors.js";
import { type Access, ionDirsOf } from "../access/index.js";
import type { Grants } from "../mcp/index.js";
import type { NeedsService } from "../needs/index.js";
import type { Db, EventStore } from "../store/index.js";
import { createRunQueue, maxRuns, type Queued } from "../scheduler/index.js";
import { chatsView } from "../views/chats.js";
import { type HistoryMessage, messagesView } from "../views/messages.js";
import { HISTORY_CHARS, withHistory } from "./history.js";
import { createWorktree, removeWorktree } from "../workspace/index.js";
import type { GateAnswer } from "../gate/index.js";
import { type AskBlocked, Approvals, type BeforeTool } from "./approvals.js";
import { keep, type Retry, type RetryState, type RunError, retryPlan, type TryEnd } from "./retry.js";
import { defaultProject, projectPath } from "./projects.js";
import type { RunAgent, RunServers } from "../tools/run-servers.js";
import { type Given, givenToRun, redactor, runMcp, type Served, yourServers } from "./servers.js";
import { type RunKeys, runEnv, runKeys } from "./run-env.js";
import { type LaunchSandbox, launchSandbox, type SandboxCtx } from "./sandbox.js";
import type { RunSkills } from "../skills/run.js";
import { agentText, type PickSource, picksOfRun, type RunPicks, shownPicks } from "../skills/picks.js";
import { type OwnForRun, ownOpts, type RunOwn, skillsAndOwn, withOwnServers } from "../tools/own-run.js";

type AskArgs = Commands["ask"]["args"];

type Active = { chatId: string; session: Session };
type Launch = {
  h: HarnessEntry;
  args: AskArgs;
  chatId: string;
  runId: string;
  cwd: string;
  /** The chat's earlier messages, for a new session that can't resume the old one. */
  history: HistoryMessage[];
  /** The harness session to continue on this try, if any. */
  resume?: string | null;
  projectId: string;
  /** Full access, or Auto (ion decides each action outside the worktree). */
  access: "auto" | "full";
  /** What you asked in this run, as you wrote it (the judge sees this, never the replayed history). */
  request: string;
  /** This run's skills plugin (ion's data folder), when its agent takes skills from ion and some are on. */
  pluginDir?: string;
  /** The skills you picked with "/" (the judge is told, in ion's words). */
  picked?: string[];
  // & your MCP servers for this run, read at its start (its retries keep them, whatever changes meanwhile): what
  // its agent is given, what ion's gateway serves (local ones ion runs, stopped when it ends), and what the agent's
  // process may not inherit from ion's environment (your keys' names and values); its agent's own tools ("Use its own
  // tools"), read at its start. & its keys (from launch to its end).
} & Partial<Given & { own: OwnForRun }> &
  RunKeys &
  LaunchSandbox;
type Between = {
  chatId: string;
  interrupt: boolean;
  wake?: () => void;
  /** The chat's session resumed but then failed for real: later tries start a new session with the history. */
  noResume?: boolean;
};

const limitIn = (file: string) =>
  maxRuns(loadUserConfig(file).config.resources.max_runs, availableParallelism());

/** Starts runs on harnesses in each chat's own worktree, and stores everything they emit. One run per chat. */
export class RunManager {
  private readonly active = new Map<string, Active>();
  private readonly approvals: Approvals;
  /** Chats with an ask in progress (before their run is active), so two asks can't race. */
  private readonly reserved = new Set<string>();
  private readonly ready = new Readiness();
  /** Runs waiting for a free slot (resources.max_runs). */
  private readonly queued = new Map<string, { chatId: string; item: Queued }>();
  private readonly queue: ReturnType<typeof createRunQueue>;
  /** Runs that left the queue and haven't ended: interrupt flags, and how to cut a retry's wait short. */
  private readonly between = new Map<string, Between>();
  private stopping = false;
  /** Runs from launch to end, for the gate to find by its key's run. */
  private readonly launches = new Map<string, Launch>();
  /** Told when a chat's run has ended and the chat is free (its queue sends the next). */
  private readonly ends: ((chatId: string) => void)[] = [];

  constructor(
    private readonly store: EventStore,
    private readonly ctx: {
      configFile: string;
      dataDir: string;
      random?: () => number;
      /** Auto access: rules, then the judge (a quick model). Without it, Auto denies. */
      access?: Access;
      /** ion's MCP server: each run gets a key for its own project, revoked when the run ends. */
      mcp?: { grants: Grants; url: () => string };
      ionBin?: string; // ion's own `ion` launcher's folder, first on every run's PATH

      /** ion's gate (`<base>/<key>`): harnesses with a hook report every tool call there before it runs. */
      gate?: { url: () => string };
      /** Asks you about a tool call ion stopped (the call waits for the answer). */
      askBlocked?: AskBlocked;
      /** Your "Before a tool runs" hooks (Settings → Tools → Hooks). */
      beforeTool?: BeforeTool;
      /** Your MCP servers for a chat's run on this agent, and the ones it goes without (Settings → Tools). */
      servers?: (agent: RunAgent) => Promise<RunServers>;
      /** Your skills for a chat's run: a plugin folder made for it (null: none, or its agent doesn't take them). */
      skills?: RunSkills;
      /** What a chat's run brings of its agent's own (its servers, skills and plugins; "Use its own tools"). */
      own?: RunOwn;
      /** What "/" and "@" can pick for a chat on this agent in this project (a message's picks resolve here). */
      picks?: (agent: string, projectId: string) => Promise<PickSource>;
    } & SandboxCtx,
    private readonly needs: NeedsService,
    private readonly db: Db,
  ) {
    // Read now and when Settings changes it (limitChanged), not at every start.
    this.queue = createRunQueue(limitIn(ctx.configFile));
    this.approvals = new Approvals(store, ctx.access, (runId) => !this.stopping && this.active.has(runId), {
      own: { home: homedir(), ionDirs: ionDirsOf(ctx) },
      ...{ askBlocked: ctx.askBlocked, beforeTool: ctx.beforeTool },
    });
  }

  /**
   * `opts.request`: what the judge treats as your request, when the message isn't yours as typed (the run your
   * answer to an agent's question starts is judged by your request from the run that asked).
   */
  async ask(
    args: AskArgs,
    opts: { request?: string; shown?: string; answers?: string; by?: "ion"; title?: string } = {},
  ): Promise<{ chatId: string; runId: string }> {
    const h = getHarness(args.harness ?? "claude-code");
    if (!h) throw new UserError(`Unknown harness: ${args.harness}`);
    // A new chat with no project goes to `default` (made the first time): every thread has a project.
    if (!args.chatId && !args.projectId)
      args = { ...args, projectId: await defaultProject(this.ctx.configFile) };
    const chat = chatFor(this.db, args, opts.title);
    // An existing chat stays in its own project: its worktree belongs to that repo.
    const projectId = chat.chatId ? chat.projectId : args.projectId;
    const repo = projectPath(this.ctx.configFile, projectId);
    if (this.stopping) throw new UserError("ion is stopping");
    const key = chat.chatId;
    if (key && this.busy(key)) throw new UserError("This chat is already running");
    if (key) this.reserved.add(key);
    let launch: Launch;
    try {
      await this.ready.check(h, args.model);
      const picks = await picksOfRun(this.ctx.picks, h.adapter.id, args, projectId);
      launch = await this.prepare(
        h,
        { ...args, shown: opts.shown, answers: opts.answers, by: opts.by, picks },
        chat,
        repo,
      );
      if (opts.request !== undefined) launch.request = opts.request;
      const l = launch;
      this.queued.set(l.runId, { chatId: l.chatId, item: this.queue.enqueue(() => this.launch(l)) });
    } finally {
      if (key) this.reserved.delete(key);
    }
    return { chatId: launch.chatId, runId: launch.runId };
  }

  /** resources.max_runs changed: start the waiting runs that now fit. */
  limitChanged(): void {
    this.queue.setLimit(limitIn(this.ctx.configFile));
  }

  /** Makes the chat's worktree (and the chat, if new), stores your message and queues the run. */
  /** `ask.shown`: what the chat shows as yours, when the text is ion's wording (your answer to a question). */
  private async prepare(
    h: HarnessEntry,
    ask: AskArgs & { shown?: string; answers?: string; by?: "ion"; picks?: RunPicks },
    chat: Chat,
    repo: string,
  ): Promise<Launch> {
    const { shown, answers, by, picks, ...args } = ask;
    const chatId = chat.chatId ?? `chat_${randomUUID()}`;
    const wt = await createWorktree(repo, this.ctx.dataDir, chatId, chat.title).catch((e: Error) => {
      throw new UserError(e.message);
    });
    if (!chat.chatId) chatCreated(this.store, { chatId, chat, wt, by });
    // History is read before your message is stored: it's what came before.
    const history = chat.chatId ? messagesView.history(this.db, chatId, HISTORY_CHARS) : [];
    const projectId = (chat.chatId ? chat.projectId : args.projectId) ?? "";
    // A thread ion started runs in Auto every time: every action there still goes through ion's checks.
    const ionThread =
      by === "ion" || chatsView.list(this.db).some((c) => c.chatId === chatId && c.by === "ion");
    const access = ionThread ? "auto" : (args.access ?? "auto");
    const runId = `run_${randomUUID()}`;
    const data = { text: args.text, ...(shown ? { shown } : {}), ...(answers ? { answers } : {}) };
    const sent = { ...data, ...shownPicks(picks) };
    this.store.append({ chatId, runId, origin: "daemon", type: EV.messageSent, data: sent });
    this.store.append({ chatId, runId, origin: "daemon", type: EV.runQueued, data: {} });
    // The agent gets your words with what you picked, its way; the judge and the chat keep your words.
    const a = { ...args, text: agentText(args.text, h.adapter.picks, picks) };
    const l = { h, args: a, chatId, runId, cwd: wt.path, history, projectId, access, request: args.text };
    // The judge is told what you picked, in ion's words.
    const picked = shownPicks(picks).skills;
    return picked ? { ...l, picked } : l;
  }

  /**
   * Runs a queued run to its end, retrying per the retry rule: each try is a new session in the same worktree
   * with the original text. Resolves when the run ends, which frees its queue slot.
   */
  private async launch(l: Launch): Promise<void> {
    this.queued.delete(l.runId);
    Object.assign(l, runKeys(this.ctx.mcp?.grants, l, !!(this.ctx.gate && l.h.adapter.gateCall)));
    this.launches.set(l.runId, l);
    const b: Between = { chatId: l.chatId, interrupt: false };
    this.between.set(l.runId, b);
    const state: RetryState = { tries: 0, effortRetried: false, effort: l.args.effort ?? null };
    try {
      Object.assign(l, await skillsAndOwn(this.ctx, l));
      Object.assign(l, launchSandbox(l.h.adapter.sandbox, this.ctx, { ...l, harness: l.h.adapter.id }));
      const yours = withOwnServers(await yourServers(this.store, this.ctx.servers, l), l.own);
      // Every key of the run (its agent's own too): redacted from every event of the run, wherever it's stored from.
      const redact = redactor([...yours.secrets, l.mcpKey, l.gateKey, l.cliKey]);
      this.store.redactRun(l.runId, redact);
      const { dataDir, configFile } = this.ctx;
      const o = { ion: this.ionServer(l), redact, dataDir, configFile };
      Object.assign(l, givenToRun(this.store, l, yours, o));
      for (;;) {
        if (this.stopping) return;
        state.tries++;
        const end = await this.tryInContext(
          { ...l, args: { ...l.args, effort: state.effort ?? undefined } },
          b,
        );
        const retry = this.planRetry(l, state, end, b);
        if (!retry) return this.finish(l, end.status);
        if (!(await this.pause(b, retry.delayS))) return this.finish(l, "interrupted");
      }
    } finally {
      // A run's local servers never outlive it.
      await l.bridges?.close();
      // Its skills plugin goes too, without holding up the chat (its next run has its own).
      void this.ctx.skills?.remove(l.runId).catch(() => {});
      this.store.endRedaction(l.runId);
      this.between.delete(l.runId);
      this.ctx.mcp?.grants.revoke(l.runId);
      this.launches.delete(l.runId);
      this.approvals.forget(l.runId);
      this.ended(l.chatId);
    }
  }

  /** `fn` hears each time a chat's run ends, however it ended, once the chat is free for its next. */
  onEnded(fn: (chatId: string) => void): void {
    this.ends.push(fn);
  }

  private ended(chatId: string): void {
    if (!this.stopping) for (const fn of this.ends) fn(chatId);
  }

  /** Whether the chat has a run starting, waiting or going. */
  busy(chatId: string): boolean {
    return this.reserved.has(chatId) || this.runOf(chatId) !== undefined;
  }

  /** Stops the chat's run, as Esc twice does (nothing when none is going). */
  async stopChat(chatId: string): Promise<void> {
    const runId = this.runOf(chatId);
    if (runId) await this.interrupt(runId);
  }

  /** Whether a try that ended this way is retried; if so, records run.retrying and updates the effort. */
  private planRetry(l: Launch, state: RetryState, end: TryEnd, b: Between): Retry | null {
    if (end.status !== "failed" || b.interrupt) return null;
    const retry = retryPlan(state, end.error, this.random);
    if (!retry) return null;
    if (retry.effort !== state.effort) state.effortRetried = true;
    state.effort = retry.effort;
    const { chatId, runId } = l;
    this.store.append({ chatId, runId, origin: "daemon", type: EV.runRetrying, data: retry });
    return retry;
  }

  private get random(): () => number {
    return this.ctx.random ?? Math.random;
  }

  /** ion's own MCP server for a run: its URL and the run's key (also the key for ion's gateway). */
  private ionServer(l: Launch): { url: string; key: string } | null {
    return this.ctx.mcp && l.mcpKey ? { url: this.ctx.mcp.url(), key: l.mcpKey } : null;
  }

  /** A daemon-side error for a run; nothing is stored once ion is stopping (the run's end is already written). */
  private daemonError(chatId: string, runId: string, data: RunError): void {
    if (!this.stopping) this.store.append({ chatId, runId, origin: "daemon", type: EV.error, data });
  }

  private finish(l: Launch, status: string): void {
    const [{ chatId, runId }, data] = [l, { status }];
    if (!this.stopping) this.store.append({ chatId, runId, origin: "daemon", type: EV.runFinished, data });
  }

  /** Waits a retry's delay; false if interrupted (or ion stopped) meanwhile. */
  private pause(b: Between, delayS: number): Promise<boolean> {
    if (b.interrupt || this.stopping) return Promise.resolve(false);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(true), delayS * 1000);
      b.wake = () => {
        clearTimeout(t);
        resolve(false);
      };
    });
  }

  /**
   * One try with the chat's context: resume the chat's last session on this harness when there is one, else a
   * new session with the chat's history before your message. A session the harness can't resume falls back to
   * the history right away (not a try of its own, and no error stored).
   */
  private async tryInContext(l: Launch, b: Between): Promise<TryEnd> {
    const s = chatsView.session(this.db, l.chatId);
    const resume = !b.noResume && s && s.harness === l.h.adapter.id ? s.sessionId : null;
    const fresh = { ...l, resume: null, args: { ...l.args, text: withHistory(l.history, l.args.text) } };
    if (!resume) return this.tryOnce(fresh, b);
    const end = await this.tryOnce({ ...l, resume }, b);
    if (end.error?.code !== "resume_failed") {
      // A resumed session that fails for real (e.g. its context is too long) isn't resumed again.
      if (end.status === "failed" && end.error && !end.error.retryable) b.noResume = true;
      return end;
    }
    if (b.interrupt || this.stopping) return { status: b.interrupt ? "interrupted" : "failed", error: null };
    return this.tryOnce(fresh, b);
  }

  /** One try: start a session, send the text, store what it emits. A failed start is a failed try. */
  private async tryOnce(l: Launch, b: Between): Promise<TryEnd> {
    let session: Session;
    try {
      session = await this.start(l);
    } catch (e) {
      if (e instanceof ResumeFailed)
        return { status: "failed", error: { code: "resume_failed", retryable: false, message: e.message } };
      this.daemonError(l.chatId, l.runId, { code: "start", retryable: false, message: (e as Error).message });
      return { status: "failed", error: null };
    }
    // Stopped or interrupted while the harness started: close it without sending the prompt.
    if (this.stopping || b.interrupt) {
      await session.close().catch(() => {});
      return { status: b.interrupt ? "interrupted" : "failed", error: null };
    }
    this.active.set(l.runId, { chatId: l.chatId, session });
    try {
      await session.send({ text: l.args.text });
    } catch (e) {
      this.active.delete(l.runId);
      await session.close().catch(() => {});
      const error = { code: "crash", retryable: true, message: (e as Error).message };
      this.daemonError(l.chatId, l.runId, error);
      return { status: "failed", error };
    }
    return this.pump(session, l.chatId, l.runId);
  }

  async interrupt(runId: string): Promise<void> {
    const waiting = this.queued.get(runId);
    if (waiting?.item.cancel()) {
      this.queued.delete(runId);
      const data = { status: "interrupted" };
      this.store.append({ chatId: waiting.chatId, runId, origin: "daemon", type: EV.runFinished, data });
      this.ended(waiting.chatId);
      return;
    }
    const b = this.between.get(runId);
    if (!b) throw new UserError("That run isn't running");
    b.interrupt = true;
    b.wake?.();
    const run = this.active.get(runId);
    if (!run) return; // starting or waiting to retry: it stops there
    this.needs.supersedeRun(runId); // a waiting permission request gets "deny", so the harness can stop
    await run.session.interrupt();
  }

  /**
   * Removes the chat's worktree (its branch and commits stay) and marks it archived. `repo`: its project's folder,
   * for a project already out of your config (being removed).
   */
  async archive(chatId: string, repo?: string): Promise<void> {
    if (this.busy(chatId)) throw new UserError("Stop the chat's run first");
    const chat = chatFor(this.db, { chatId, text: "" });
    const worktree = chatsView.worktree(this.db, chatId);
    if (worktree) await removeWorktree(repo ?? projectPath(this.ctx.configFile, chat.projectId), worktree);
    this.needs.supersedeChat(chatId);
    this.store.append({ chatId, runId: null, origin: "daemon", type: EV.chatArchived, data: {} });
  }

  /** ion is stopping: every active run ends as failed, and its harness session is closed. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const [runId, { chatId, item }] of this.queued)
      if (item.cancel()) this.endFailed(chatId, runId, "daemon_stopped", "ion stopped");
    this.queued.clear();
    for (const [runId, b] of this.between) {
      b.wake?.();
      this.needs.supersedeRun(runId);
      this.endFailed(b.chatId, runId, "daemon_stopped", "ion stopped");
    }
    for (const { session } of this.active.values()) await session.close().catch(() => {});
    this.active.clear();
    await Promise.all([...this.launches.values()].map((l) => l.bridges?.close()));
  }

  /** Runs a crash left without an end (still queued or running) are closed as failed. */
  closeUnfinishedRuns(rows: { runId: string; chatId: string | null; status: string }[]): void {
    for (const r of rows)
      if (r.status === "running" || r.status === "queued") {
        this.needs.supersedeRun(r.runId);
        this.endFailed(r.chatId, r.runId, "daemon_restarted", "ion stopped before this run finished");
      }
  }

  /** The chat's run waiting for a slot or going, if any. */
  private runOf(chatId: string): string | undefined {
    return [...this.queued, ...this.between].find(([, r]) => r.chatId === chatId)?.[0];
  }

  private endFailed(chatId: string | null, runId: string, code: string, message: string): void {
    const data = { code, retryable: false, message };
    this.store.append({ chatId, runId, origin: "daemon", type: EV.error, data });
    this.store.append({ chatId, runId, origin: "daemon", type: EV.runFinished, data: { status: "failed" } });
  }

  private async start(l: Launch): Promise<Session> {
    const roots = projectRoots(l.cwd);
    return l.h.adapter.start({
      cwd: l.cwd,
      model: l.args.model ?? null,
      effort: l.args.effort ?? null,
      ...(l.resume ? { resume: l.resume } : {}),
      env: runEnv(l, this.ctx.ionBin, this.ctx.port?.()),
      ...(l.sandbox ? { sandbox: l.sandbox } : {}),
      ...(this.ctx.gate && l.gateKey ? { gate: { url: `${this.ctx.gate.url()}/${l.gateKey}` } } : {}),
      ...runMcp(this.ionServer(l), l.servers, l.envDrop),
      ...(l.pluginDir ? { pluginDir: l.pluginDir } : {}),
      ...ownOpts(l.own),
      signal: new AbortController().signal,
      decide: (req: ApprovalRequest) => this.approvals.decide(l, req, roots),
      holding: this.approvals.holding(l.runId),
    });
  }

  /** What you asked in a run, while it's queued or going (the judge's "request"); null once it ended. */
  requestOf(runId: string): string | null {
    return this.launches.get(runId)?.request ?? null;
  }

  /** A tool call a run's hook reported (its gate key's run); null when the harness's payload isn't one. */
  async gate(runId: string, payload: unknown): Promise<GateAnswer | null> {
    const l = this.launches.get(runId);
    const call = l?.h.adapter.gateCall?.(payload);
    if (!l || !call) return null;
    return this.approvals.gate(l, call, projectRoots(l.cwd));
  }

  /** One of your servers given to a running run, for ion's gateway; null once the run ended. */
  upstream(runId: string, name: string): Served | null {
    return this.launches.get(runId)?.upstreams?.get(name) ?? null;
  }

  /** A tools/call at ion's gateway for a run: decided like the run's other calls. */
  async gateMcp(runId: string, call: GateCall): Promise<GateAnswer> {
    const l = this.launches.get(runId);
    return l
      ? this.approvals.gateway(l, call, projectRoots(l.cwd))
      : { decision: "deny", reason: "This run has ended" };
  }

  /** Stores what a session emits, except its run.finished: whether the run ends or retries is decided above. */
  private async pump(session: Session, chatId: string, runId: string): Promise<TryEnd> {
    const end: TryEnd = { status: "failed", error: null };
    try {
      for await (const e of session.events()) {
        if (this.stopping) break;
        if (keep(e, end))
          this.approvals.noteStored(this.store.append({ ...e, chatId, runId, origin: "adapter" }));
      }
    } catch (e) {
      // The harness stream broke (a crashed CLI): transient.
      end.error = { code: "crash", retryable: true, message: (e as Error).message };
      this.daemonError(chatId, runId, end.error);
    } finally {
      this.needs.supersedeRun(runId);
      this.active.delete(runId);
      await session.close().catch(() => {});
    }
    return end;
  }
}
