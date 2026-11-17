import { createHash, randomUUID } from "node:crypto";
import { availableParallelism } from "node:os";
import { type ApprovalRequest, type Decision, projectRoots, type Session } from "@ion/adapter-kit";
import { loadUserConfig } from "@ion/config";
import { type Commands, EV, type IonEvent } from "@ion/schema";
import { getHarness, type HarnessEntry } from "../adapters/registry.js";
import { UserError } from "../api/errors.js";
import { needDetail, type NeedsService } from "../needs/index.js";
import type { Db, EventStore } from "../store/index.js";
import { createRunQueue, maxRuns, type Queued } from "../scheduler/index.js";
import { chatsView } from "../views/chats.js";
import { createWorktree, removeWorktree } from "../workspace/index.js";
import { decideByPolicy } from "./policy.js";
import { type Retry, type RetryState, type RunError, retryPlan } from "./retry.js";

type AskArgs = Commands["ask"]["args"];
type Active = { chatId: string; session: Session };
type Chat = { chatId: string | null; projectId: string | null; title: string };
type Launch = { h: HarnessEntry; args: AskArgs; chatId: string; runId: string; cwd: string };
type Between = { chatId: string; interrupt: boolean; wake?: () => void };
type TryEnd = { status: string; error: RunError | null };

/** Starts runs on harnesses in each chat's own worktree, and stores everything they emit. One run per chat. */
export class RunManager {
  private readonly active = new Map<string, Active>();
  private readonly requested = new Map<string, () => void>();
  /** Chats with an ask in progress (before their run is active), so two asks can't race. */
  private readonly reserved = new Set<string>();
  /** Runs waiting for a free slot (resources.max_runs). */
  private readonly queued = new Map<string, { chatId: string; item: Queued }>();
  private readonly queue: ReturnType<typeof createRunQueue>;
  /** Runs that left the queue and haven't ended: interrupt flags, and how to cut a retry's wait short. */
  private readonly between = new Map<string, Between>();
  private stopping = false;

  constructor(
    private readonly store: EventStore,
    private readonly ctx: { configFile: string; dataDir: string; random?: () => number },
    private readonly needs: NeedsService,
    private readonly db: Db,
  ) {
    const setting = loadUserConfig(ctx.configFile).config.resources.max_runs;
    this.queue = createRunQueue(maxRuns(setting, availableParallelism()));
  }

  async ask(args: AskArgs): Promise<{ chatId: string; runId: string }> {
    const h = getHarness(args.harness ?? "claude-code");
    if (!h) throw new UserError(`Unknown harness: ${args.harness}`);
    const chat = this.chatFor(args);
    const repo = this.projectPath(args.projectId ?? chat.projectId);
    if (this.stopping) throw new UserError("ion is stopping");
    const key = chat.chatId;
    if (key && (this.reserved.has(key) || this.runningIn(key)))
      throw new UserError("This chat is already running");
    if (key) this.reserved.add(key);
    let launch: Launch;
    try {
      await this.checkReady(h);
      const chatId = chat.chatId ?? `chat_${randomUUID()}`;
      const wt = await createWorktree(repo, this.ctx.dataDir, chatId, chat.title).catch((e: Error) => {
        throw new UserError(e.message);
      });
      if (!chat.chatId) this.createChat(chatId, chat, wt);
      launch = { h, args, chatId, runId: `run_${randomUUID()}`, cwd: wt.path };
      this.store.append({ chatId, runId: launch.runId, origin: "daemon", type: EV.runQueued, data: {} });
      const l = launch;
      this.queued.set(l.runId, { chatId, item: this.queue.enqueue(() => this.launch(l)) });
    } finally {
      if (key) this.reserved.delete(key);
    }
    return { chatId: launch.chatId, runId: launch.runId };
  }

  /**
   * Runs a queued run to its end, retrying per the retry rule: each try is a new session in the same worktree
   * with the original text. Resolves when the run ends, which frees its queue slot.
   */
  private async launch(l: Launch): Promise<void> {
    this.queued.delete(l.runId);
    const b: Between = { chatId: l.chatId, interrupt: false };
    this.between.set(l.runId, b);
    const state: RetryState = { tries: 0, effortRetried: false, effort: l.args.effort ?? null };
    try {
      for (;;) {
        if (this.stopping) return;
        state.tries++;
        const end = await this.tryOnce({ ...l, args: { ...l.args, effort: state.effort ?? undefined } }, b);
        const retry = this.planRetry(l, state, end, b);
        if (!retry) return this.finish(l, end.status);
        if (!(await this.pause(b, retry.delayS))) return this.finish(l, "interrupted");
      }
    } finally {
      this.between.delete(l.runId);
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

  /** One try: start a session, send the text, store what it emits. A failed start is a failed try. */
  private async tryOnce(l: Launch, b: Between): Promise<TryEnd> {
    let session: Session;
    try {
      session = await this.start(l);
    } catch (e) {
      this.store.append({
        chatId: l.chatId,
        runId: l.runId,
        origin: "daemon",
        type: EV.error,
        data: { code: "start", retryable: false, message: (e as Error).message },
      });
      return { status: "failed", error: null };
    }
    if (this.stopping) {
      await session.close().catch(() => {});
      return { status: "failed", error: null };
    }
    this.active.set(l.runId, { chatId: l.chatId, session });
    if (b.interrupt) void session.interrupt();
    try {
      await session.send({ text: l.args.text });
    } catch (e) {
      this.active.delete(l.runId);
      await session.close().catch(() => {});
      const error = { code: "crash", retryable: true, message: (e as Error).message };
      this.store.append({ chatId: l.chatId, runId: l.runId, origin: "daemon", type: EV.error, data: error });
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

  private projectPath(projectId: string | null | undefined): string {
    if (!projectId) throw new UserError("Pick a project with -p <project>");
    const p = loadUserConfig(this.ctx.configFile).config.projects.find((x) => x.id === projectId);
    if (!p) throw new UserError(`Unknown project: ${projectId}`);
    return p.path;
  }

  private async checkReady(h: HarnessEntry): Promise<void> {
    if (!(await h.adapter.detect()).installed) throw new UserError(`${h.label} isn't installed`);
    if (!(await h.adapter.auth.status()).signedIn)
      throw new UserError(`${h.label} isn't signed in. Run: ${h.loginHint}`);
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
    const decide = (req: ApprovalRequest) => this.decide(l, req, roots);
    return l.h.adapter.start({
      cwd: l.cwd,
      model: l.args.model ?? null,
      effort: l.args.effort ?? null,
      signal: new AbortController().signal,
      decide,
    });
  }

  /** Inside the worktree: allowed by policy. Anything else: a need you answer. Recorded after the request. */
  private async decide(l: Launch, req: ApprovalRequest, roots: string[]): Promise<Decision> {
    await this.waitForRequest(req.requestId);
    const byPolicy = decideByPolicy(req, { roots }) === "allow";
    const decision: Decision = byPolicy
      ? "allow"
      : await this.needs.raise({
          chatId: l.chatId,
          runId: l.runId,
          requestId: req.requestId,
          kind: req.kind,
          summary: req.summary,
          detail: needDetail(req.input),
          dedupeKey: `${l.h.adapter.id}:${req.toolName}:${createHash("sha256").update(JSON.stringify(req.input)).digest("hex")}`,
        });
    // The run may have ended while we waited (interrupt, shutdown): its log is closed.
    if (this.stopping || !this.active.has(l.runId)) return decision;
    this.store.append({
      chatId: l.chatId,
      runId: l.runId,
      origin: "daemon",
      type: EV.approvalResolved,
      data: { requestId: req.requestId, decision, by: byPolicy ? "policy" : "you" },
    });
    return decision;
  }

  /** Resolves once the adapter's approval.requested for this id is stored, so the log stays in order. */
  private waitForRequest(requestId: string): Promise<void> {
    if (this.requested.has(`seen:${requestId}`)) return Promise.resolve();
    return new Promise((resolve) => this.requested.set(requestId, resolve));
  }

  private noteStored(e: IonEvent): void {
    if (e.type !== EV.approvalRequested) return;
    const id = (e.data as { requestId: string }).requestId;
    const waiter = this.requested.get(id);
    if (waiter) {
      this.requested.delete(id);
      waiter();
    } else this.requested.set(`seen:${id}`, () => {});
  }

  /** Stores what a session emits, except its run.finished: whether the run ends or retries is decided above. */
  private async pump(session: Session, chatId: string, runId: string): Promise<TryEnd> {
    const end: TryEnd = { status: "failed", error: null };
    try {
      for await (const e of session.events()) {
        if (this.stopping) break;
        if (e.type === EV.runFinished) {
          end.status = String((e.data as { status: string }).status);
          continue;
        }
        this.noteStored(this.store.append({ ...e, chatId, runId, origin: "adapter" }));
        if (e.type === EV.error) end.error = e.data as RunError;
      }
    } catch (e) {
      // The harness stream broke (a crashed CLI): transient.
      end.error = { code: "crash", retryable: true, message: (e as Error).message };
      this.store.append({ chatId, runId, origin: "daemon", type: EV.error, data: end.error });
    } finally {
      this.needs.supersedeRun(runId);
      this.active.delete(runId);
      await session.close().catch(() => {});
    }
    return end;
  }
}
