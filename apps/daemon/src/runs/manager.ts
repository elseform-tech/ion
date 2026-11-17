import { randomUUID } from "node:crypto";
import { type ApprovalRequest, projectRoots, type Session } from "@ion/adapter-kit";
import { loadUserConfig } from "@ion/config";
import { type Commands, EV, type IonEvent } from "@ion/schema";
import { getHarness, type HarnessEntry } from "../adapters/registry.js";
import { UserError } from "../api/errors.js";
import type { EventStore } from "../store/index.js";
import { decideByPolicy } from "./policy.js";

type AskArgs = Commands["ask"]["args"];
type Active = { chatId: string; session: Session };

/** Starts runs on harnesses and stores everything they emit. One active run per chat. */
export class RunManager {
  private readonly active = new Map<string, Active>();
  private readonly requested = new Map<string, () => void>();
  /** Chats with an ask in progress (before their run is active), so two asks can't race. */
  private readonly reserved = new Set<string>();
  private stopping = false;

  constructor(
    private readonly store: EventStore,
    private readonly ctx: { configFile: string },
  ) {}

  async ask(args: AskArgs): Promise<{ chatId: string; runId: string }> {
    const h = getHarness(args.harness ?? "claude-code");
    if (!h) throw new UserError(`Unknown harness: ${args.harness}`);
    const chat = this.chatFor(args);
    const cwd = this.projectPath(args.projectId ?? chat.projectId);
    if (this.stopping) throw new UserError("ion is stopping");
    const key = chat.chatId;
    if (key && (this.reserved.has(key) || [...this.active.values()].some((a) => a.chatId === key)))
      throw new UserError("This chat is already running");
    if (key) this.reserved.add(key);
    let started: { chatId: string; runId: string; session: Session };
    try {
      await this.checkReady(h);
      const chatId = chat.chatId ?? this.createChat(args);
      const runId = `run_${randomUUID()}`;
      started = { chatId, runId, session: await this.start(h, { args, cwd, chatId, runId }) };
      this.active.set(runId, { chatId, session: started.session });
    } finally {
      if (key) this.reserved.delete(key);
    }
    const { chatId, runId, session } = started;
    await session.send({ text: args.text });
    void this.pump(session, chatId, runId);
    return { chatId, runId };
  }

  /** ion is stopping: every active run ends as failed, and its harness session is closed. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const [runId, { chatId, session }] of this.active) {
      this.endFailed(chatId, runId, "daemon_stopped", "ion stopped");
      await session.close().catch(() => {});
    }
    this.active.clear();
  }

  /** Runs a crash left without an end (still queued or running) are closed as failed. */
  closeUnfinishedRuns(rows: { runId: string; chatId: string | null; status: string }[]): void {
    for (const r of rows)
      if (r.status === "running" || r.status === "queued")
        this.endFailed(r.chatId, r.runId, "daemon_restarted", "ion stopped before this run finished");
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

  async interrupt(runId: string): Promise<void> {
    const run = this.active.get(runId);
    if (!run) throw new UserError("That run isn't running");
    await run.session.interrupt();
  }

  private chatFor(args: AskArgs): { chatId: string | null; projectId: string | null } {
    if (!args.chatId) return { chatId: null, projectId: args.projectId ?? null };
    const created = this.store.read({ chatId: args.chatId, limit: 1 })[0];
    if (created?.type !== EV.chatCreated) throw new UserError(`Unknown chat: ${args.chatId}`);
    return { chatId: args.chatId, projectId: (created.data as { projectId: string | null }).projectId };
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

  private createChat(args: AskArgs): string {
    const chatId = `chat_${randomUUID()}`;
    const title = args.text.trim().split("\n")[0]!.slice(0, 60);
    this.store.append({
      chatId,
      runId: null,
      origin: "daemon",
      type: EV.chatCreated,
      data: { title, projectId: args.projectId ?? null },
    });
    return chatId;
  }

  private async start(
    h: HarnessEntry,
    r: { args: AskArgs; cwd: string; chatId: string; runId: string },
  ): Promise<Session> {
    const roots = projectRoots(r.cwd);
    const decide = async (req: ApprovalRequest) => {
      await this.waitForRequest(req.requestId);
      const decision = decideByPolicy(req, { allowEdits: r.args.allowEdits === true, roots });
      this.store.append({
        chatId: r.chatId,
        runId: r.runId,
        origin: "daemon",
        type: EV.approvalResolved,
        data: { requestId: req.requestId, decision, by: "policy" },
      });
      return decision;
    };
    try {
      return await h.adapter.start({
        cwd: r.cwd,
        model: r.args.model ?? null,
        effort: r.args.effort ?? null,
        signal: new AbortController().signal,
        decide,
      });
    } catch (e) {
      throw new UserError((e as Error).message);
    }
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
        const stored = this.store.append({ ...e, chatId, runId, origin: "adapter" });
        this.noteStored(stored);
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
      this.active.delete(runId);
      await session.close().catch(() => {});
    }
  }
}
