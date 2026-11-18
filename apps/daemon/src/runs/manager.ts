import { randomUUID } from "node:crypto";
import { availableParallelism } from "node:os";
import {
  type AdapterEvent,
  type ApprovalRequest,
  projectRoots,
  ResumeFailed,
  type Session,
} from "@ion/adapter-kit";
import { DEFAULT_PROJECT, loadUserConfig, saveUserConfig } from "@ion/config";
import { type Commands, EV } from "@ion/schema";
import { getHarness, type HarnessEntry } from "../adapters/registry.js";
import { UserError } from "../api/errors.js";
import type { Access } from "../access/index.js";
import type { Grants } from "../mcp/index.js";
import type { NeedsService } from "../needs/index.js";
import type { Db, EventStore } from "../store/index.js";
import { createRunQueue, maxRuns, type Queued } from "../scheduler/index.js";
import { chatsView } from "../views/chats.js";
import { type HistoryMessage, messagesView } from "../views/messages.js";
import { HISTORY_CHARS, withHistory } from "./history.js";
import { createWorktree, ensureDefaultProject, removeWorktree } from "../workspace/index.js";
import type { GateAnswer } from "../gate/index.js";
import { Approvals } from "./approvals.js";
import { type Retry, type RetryState, type RunError, retryPlan } from "./retry.js";

type AskArgs = Commands["ask"]["args"];
type Active = { chatId: string; session: Session };
type Chat = { chatId: string | null; projectId: string | null; title: string };
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
  /** This run's MCP key (from launch until the run ends). */
  mcpKey?: string;
  /** This run's gate key, when its harness reports tool calls through a hook. */
  gateKey?: string;
};
type Between = {
  chatId: string;
  interrupt: boolean;
  wake?: () => void;
  /** The chat's session resumed but then failed for real: later tries start a new session with the history. */
  noResume?: boolean;
};
type TryEnd = { status: string; error: RunError | null };

/** Starts runs on harnesses in each chat's own worktree, and stores everything they emit. One run per chat. */
export class RunManager {
  private readonly active = new Map<string, Active>();
  private readonly approvals: Approvals;
  /** Chats with an ask in progress (before their run is active), so two asks can't race. */
  private readonly reserved = new Set<string>();
  /** Runs waiting for a free slot (resources.max_runs). */
  private readonly queued = new Map<string, { chatId: string; item: Queued }>();
  private readonly queue: ReturnType<typeof createRunQueue>;
  /** Runs that left the queue and haven't ended: interrupt flags, and how to cut a retry's wait short. */
  private readonly between = new Map<string, Between>();
  private stopping = false;
  /** Runs from launch to end, for the gate to find by its key's run. */
  private readonly launches = new Map<string, Launch>();

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
      /** ion's gate (`<base>/<key>`): harnesses with a hook report every tool call there before it runs. */
      gate?: { url: () => string };
    },
    private readonly needs: NeedsService,
    private readonly db: Db,
  ) {
    const setting = loadUserConfig(ctx.configFile).config.resources.max_runs;
    this.queue = createRunQueue(maxRuns(setting, availableParallelism()));
    this.approvals = new Approvals(store, ctx.access, (runId) => !this.stopping && this.active.has(runId));
  }

  async ask(args: AskArgs): Promise<{ chatId: string; runId: string }> {
    const h = getHarness(args.harness ?? "claude-code");
    if (!h) throw new UserError(`Unknown harness: ${args.harness}`);
    // A new chat with no project goes to `default` (made the first time): every thread has a project.
    if (!args.chatId && !args.projectId) args = { ...args, projectId: await this.defaultProject() };
    const chat = this.chatFor(args);
    // An existing chat stays in its own project: its worktree belongs to that repo.
    const repo = this.projectPath(chat.chatId ? chat.projectId : args.projectId);
    if (this.stopping) throw new UserError("ion is stopping");
    const key = chat.chatId;
    if (key && (this.reserved.has(key) || this.runningIn(key)))
      throw new UserError("This chat is already running");
    if (key) this.reserved.add(key);
    let launch: Launch;
    try {
      await this.checkReady(h, args.model);
      launch = await this.prepare(h, args, chat, repo);
      const l = launch;
      this.queued.set(l.runId, { chatId: l.chatId, item: this.queue.enqueue(() => this.launch(l)) });
    } finally {
      if (key) this.reserved.delete(key);
    }
    return { chatId: launch.chatId, runId: launch.runId };
  }

  /** Makes the chat's worktree (and the chat, if new), stores your message and queues the run. */
  private async prepare(h: HarnessEntry, args: AskArgs, chat: Chat, repo: string): Promise<Launch> {
    const chatId = chat.chatId ?? `chat_${randomUUID()}`;
    const wt = await createWorktree(repo, this.ctx.dataDir, chatId, chat.title).catch((e: Error) => {
      throw new UserError(e.message);
    });
    if (!chat.chatId) this.createChat(chatId, chat, wt);
    // History is read before your message is stored: it's what came before.
    const history = chat.chatId ? messagesView.history(this.db, chatId, HISTORY_CHARS) : [];
    const projectId = (chat.chatId ? chat.projectId : args.projectId) ?? "";
    const access = args.access ?? this.accessFor(projectId);
    const runId = `run_${randomUUID()}`;
    this.store.append({ chatId, runId, origin: "daemon", type: EV.messageSent, data: { text: args.text } });
    this.store.append({ chatId, runId, origin: "daemon", type: EV.runQueued, data: {} });
    return { h, args, chatId, runId, cwd: wt.path, history, projectId, access, request: args.text };
  }

  /**
   * Runs a queued run to its end, retrying per the retry rule: each try is a new session in the same worktree
   * with the original text. Resolves when the run ends, which frees its queue slot.
   */
  private async launch(l: Launch): Promise<void> {
    this.queued.delete(l.runId);
    const scope = { projectId: l.projectId, chatId: l.chatId, runId: l.runId };
    l.mcpKey = this.ctx.mcp?.grants.create(scope);
    if (this.ctx.gate && l.h.adapter.gateCall) l.gateKey = this.ctx.mcp?.grants.create(scope, "gate");
    this.launches.set(l.runId, l);
    const b: Between = { chatId: l.chatId, interrupt: false };
    this.between.set(l.runId, b);
    const state: RetryState = { tries: 0, effortRetried: false, effort: l.args.effort ?? null };
    try {
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
      this.between.delete(l.runId);
      this.ctx.mcp?.grants.revoke(l.runId);
      this.launches.delete(l.runId);
      this.approvals.forget(l.runId);
    }
  }

  /** Whether a try that ended this way is retried; if so, records run.retrying and updates the effort. */
  private planRetry(l: Launch, state: RetryState, end: TryEnd, b: Between): Retry | null {
    if (end.status !== "failed" || b.interrupt) return null;
    const retry = retryPlan(state, end.error, this.random);
    if (!retry) return null;
    if (retry.effort !== state.effort) state.effortRetried = true;
    state.effort = retry.effort;
    this.store.append({
      chatId: l.chatId,
      runId: l.runId,
      origin: "daemon",
      type: EV.runRetrying,
      data: retry,
    });
    return retry;
  }

  private get random(): () => number {
    return this.ctx.random ?? Math.random;
  }

  /** A daemon-side error for a run; nothing is stored once ion is stopping (the run's end is already written). */
  private daemonError(chatId: string, runId: string, data: RunError): void {
    if (!this.stopping) this.store.append({ chatId, runId, origin: "daemon", type: EV.error, data });
  }

  private finish(l: Launch, status: string): void {
    if (!this.stopping)
      this.store.append({
        chatId: l.chatId,
        runId: l.runId,
        origin: "daemon",
        type: EV.runFinished,
        data: { status },
      });
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

  /** Removes the chat's worktree (its branch and commits stay) and marks it archived. */
  async archive(chatId: string): Promise<void> {
    if (this.runningIn(chatId)) throw new UserError("Stop the chat's run first");
    const chat = this.chatFor({ chatId, text: "" });
    const worktree = chatsView.worktree(this.db, chatId);
    if (worktree) await removeWorktree(this.projectPath(chat.projectId), worktree);
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
  }

  /** Runs a crash left without an end (still queued or running) are closed as failed. */
  closeUnfinishedRuns(rows: { runId: string; chatId: string | null; status: string }[]): void {
    for (const r of rows)
      if (r.status === "running" || r.status === "queued") {
        this.needs.supersedeRun(r.runId);
        this.endFailed(r.chatId, r.runId, "daemon_restarted", "ion stopped before this run finished");
      }
  }

  private runningIn(chatId: string): boolean {
    const all = [...this.queued.values(), ...this.between.values()];
    return all.some((a) => a.chatId === chatId);
  }

  private endFailed(chatId: string | null, runId: string, code: string, message: string): void {
    this.store.append({
      chatId,
      runId,
      origin: "daemon",
      type: EV.error,
      data: { code, retryable: false, message },
    });
    this.store.append({ chatId, runId, origin: "daemon", type: EV.runFinished, data: { status: "failed" } });
  }

  private chatFor(args: { chatId?: string; projectId?: string; text: string }): Chat {
    if (!args.chatId)
      return {
        chatId: null,
        projectId: args.projectId ?? null,
        title: args.text.trim().split("\n")[0]!.slice(0, 60),
      };
    const chat = chatsView.list(this.db).find((c) => c.chatId === args.chatId);
    if (!chat) throw new UserError(`Unknown chat: ${args.chatId}`);
    if (chat.archived) throw new UserError("That chat is archived");
    return { chatId: chat.chatId, projectId: chat.projectId, title: chat.title };
  }

  /** The project's own access mode, else the default from config.toml. */
  private accessFor(projectId: string): "auto" | "full" {
    const { config } = loadUserConfig(this.ctx.configFile);
    return config.projects.find((p) => p.id === projectId)?.access ?? config.access.default;
  }

  private async defaultProject(): Promise<string> {
    const { config, error } = loadUserConfig(this.ctx.configFile);
    if (error) throw new UserError(`Fix your config first. ${error}`);
    const next = await ensureDefaultProject(config).catch((e: Error) => {
      throw new UserError(e.message);
    });
    if (next !== config) saveUserConfig(this.ctx.configFile, next);
    return DEFAULT_PROJECT;
  }

  private projectPath(projectId: string | null | undefined): string {
    if (!projectId) throw new UserError("Pick a project with -p <project>");
    const p = loadUserConfig(this.ctx.configFile).config.projects.find((x) => x.id === projectId);
    if (!p) throw new UserError(`Unknown project: ${projectId}`);
    return p.path;
  }

  private async checkReady(h: HarnessEntry, model?: string): Promise<void> {
    if (!(await h.adapter.detect()).installed) throw new UserError(`${h.label} isn't installed`);
    if (!(await h.adapter.auth.status()).signedIn)
      throw new UserError(`${h.label} isn't signed in. Run: ${h.loginHint}`);
    // A live model list is the harness's own: a name it doesn't list won't run.
    if (!model) return;
    const caps = await h.adapter.capabilities();
    if (caps.modelsLive && !caps.models.some((x) => x.id === model))
      throw new UserError(`Unknown model for ${h.label}: ${model}`);
  }

  private createChat(chatId: string, chat: Chat, wt: { path: string; branch: string }): void {
    this.store.append({
      chatId,
      runId: null,
      origin: "daemon",
      type: EV.chatCreated,
      data: { title: chat.title, projectId: chat.projectId, worktree: wt.path, branch: wt.branch },
    });
  }

  private async start(l: Launch): Promise<Session> {
    const roots = projectRoots(l.cwd);
    const decide = (req: ApprovalRequest) => this.approvals.decide(l, req, roots);
    return l.h.adapter.start({
      cwd: l.cwd,
      model: l.args.model ?? null,
      effort: l.args.effort ?? null,
      ...(l.resume ? { resume: l.resume } : {}),
      ...(this.ctx.gate && l.gateKey ? { gate: { url: `${this.ctx.gate.url()}/${l.gateKey}` } } : {}),
      ...(this.ctx.mcp && l.mcpKey
        ? {
            mcp: {
              name: "ion" as const,
              url: this.ctx.mcp.url(),
              headers: { Authorization: `Bearer ${l.mcpKey}` },
            },
          }
        : {}),
      signal: new AbortController().signal,
      decide,
    });
  }

  /** A tool call a run's hook reported (its gate key's run); null when the harness's payload isn't one. */
  async gate(runId: string, payload: unknown): Promise<GateAnswer | null> {
    const l = this.launches.get(runId);
    const call = l?.h.adapter.gateCall?.(payload);
    if (!l || !call) return null;
    return this.approvals.gate(l, call, projectRoots(l.cwd));
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

/**
 * Notes how a try ends; false for the events the daemon keeps back: the harness's run.finished (whether the run
 * ends or retries is decided above) and a refused resume (ion retries with the history instead).
 */
function keep(e: AdapterEvent, end: TryEnd): boolean {
  if (e.type === EV.runFinished) {
    end.status = String((e.data as { status: string }).status);
    return false;
  }
  if (e.type !== EV.error) return true;
  end.error = e.data as RunError;
  return end.error.code !== "resume_failed";
}
