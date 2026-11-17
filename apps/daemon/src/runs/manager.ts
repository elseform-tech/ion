import { createHash, randomUUID } from "node:crypto";
import { type ApprovalRequest, type Decision, projectRoots, type Session } from "@ion/adapter-kit";
import { loadUserConfig } from "@ion/config";
import { type Commands, EV, type IonEvent } from "@ion/schema";
import { getHarness, type HarnessEntry } from "../adapters/registry.js";
import { UserError } from "../api/errors.js";
import type { NeedsService } from "../needs/index.js";
import type { Db, EventStore } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { createWorktree, removeWorktree } from "../workspace/index.js";
import { decideByPolicy } from "./policy.js";

type AskArgs = Commands["ask"]["args"];
type Active = { chatId: string; session: Session };
type Chat = { chatId: string | null; projectId: string | null; title: string };
type Launch = { h: HarnessEntry; args: AskArgs; chatId: string; runId: string; cwd: string };

/** Starts runs on harnesses in each chat's own worktree, and stores everything they emit. One run per chat. */
export class RunManager {
  private readonly active = new Map<string, Active>();
  private readonly requested = new Map<string, () => void>();
  /** Chats with an ask in progress (before their run is active), so two asks can't race. */
  private readonly reserved = new Set<string>();
  private stopping = false;

  constructor(
    private readonly store: EventStore,
    private readonly ctx: { configFile: string; dataDir: string },
    private readonly needs: NeedsService,
    private readonly db: Db,
  ) {}

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
      this.active.set(launch.runId, { chatId, session: await this.start(launch) });
    } finally {
      if (key) this.reserved.delete(key);
    }
    const session = this.active.get(launch.runId)!.session;
    await session.send({ text: args.text });
    void this.pump(session, launch.chatId, launch.runId);
    return { chatId: launch.chatId, runId: launch.runId };
  }

  async interrupt(runId: string): Promise<void> {
    const run = this.active.get(runId);
    if (!run) throw new UserError("That run isn't running");
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
    for (const [runId, { chatId, session }] of this.active) {
      this.needs.supersedeRun(runId);
      this.endFailed(chatId, runId, "daemon_stopped", "ion stopped");
      await session.close().catch(() => {});
    }
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
    return [...this.active.values()].some((a) => a.chatId === chatId);
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
    try {
      return await l.h.adapter.start({
        cwd: l.cwd,
        model: l.args.model ?? null,
        effort: l.args.effort ?? null,
        signal: new AbortController().signal,
        decide,
      });
    } catch (e) {
      throw new UserError((e as Error).message);
    }
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
          detail: JSON.stringify(req.input).slice(0, 2000),
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

  private async pump(session: Session, chatId: string, runId: string): Promise<void> {
    let finished = false;
    try {
      for await (const e of session.events()) {
        if (this.stopping) break;
        this.noteStored(this.store.append({ ...e, chatId, runId, origin: "adapter" }));
        if (e.type === EV.runFinished) finished = true;
      }
    } catch (e) {
      this.store.append({
        chatId,
        runId,
        origin: "daemon",
        type: EV.error,
        data: { code: "adapter", retryable: false, message: (e as Error).message },
      });
    } finally {
      if (!finished && !this.stopping)
        this.store.append({
          chatId,
          runId,
          origin: "daemon",
          type: EV.runFinished,
          data: { status: "failed" },
        });
      this.needs.supersedeRun(runId);
      this.active.delete(runId);
      await session.close().catch(() => {});
    }
  }
}
