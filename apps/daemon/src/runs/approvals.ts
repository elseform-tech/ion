import type { ApprovalRequest, Decision } from "@ion/adapter-kit";
import { EV, type IonEvent } from "@ion/schema";
import type { Access } from "../access/index.js";
import type { EventStore } from "../store/index.js";
import { decideByPolicy } from "./policy.js";

/** What a permission decision needs to know about the run asking. */
export type AskingRun = {
  chatId: string;
  runId: string;
  projectId: string;
  /** What you asked in this run (the judge sees this, never replayed history). */
  request: string;
  access: "auto" | "full";
  mcpKey?: string;
};

type Verdict = { decision: Decision; by: "policy" | "full" | "ion"; reason?: string };

/**
 * Every permission request a harness makes. Inside the worktree (and ion's own MCP tools): allowed by policy.
 * Anything else goes by the run's access: Full access allows it; Auto lets ion decide (rules, then the judge).
 * The run never pauses for you. Each decision is stored after the request it answers.
 */
export class Approvals {
  private readonly requested = new Map<string, () => void>();

  constructor(
    private readonly store: EventStore,
    private readonly access: Access | undefined,
    /** False once the run has ended (interrupt, shutdown): its log is closed. */
    private readonly isOpen: (runId: string) => boolean,
  ) {}

  async decide(r: AskingRun, req: ApprovalRequest, roots: string[]): Promise<Decision> {
    await this.waitForRequest(req.requestId);
    if (!this.isOpen(r.runId)) return "deny";
    const v = await this.verdict(r, req, roots);
    if (!this.isOpen(r.runId)) return v.decision;
    const data = {
      requestId: req.requestId,
      decision: v.decision,
      by: v.by,
      ...(v.reason ? { reason: v.reason } : {}),
    };
    this.store.append({
      chatId: r.chatId,
      runId: r.runId,
      origin: "daemon",
      type: EV.approvalResolved,
      data,
    });
    return v.decision;
  }

  /** Call with every stored adapter event: an approval.requested lets its decision be stored after it. */
  noteStored(e: IonEvent): void {
    if (e.type !== EV.approvalRequested) return;
    const id = (e.data as { requestId: string }).requestId;
    const waiter = this.requested.get(id);
    if (waiter) {
      this.requested.delete(id);
      waiter();
    } else this.requested.set(`seen:${id}`, () => {});
  }

  private async verdict(r: AskingRun, req: ApprovalRequest, roots: string[]): Promise<Verdict> {
    if (decideByPolicy(req, { roots, ionMcp: Boolean(r.mcpKey) }) === "allow")
      return { decision: "allow", by: "policy" };
    if (r.access === "full") return { decision: "allow", by: "full" };
    if (!this.access)
      return { decision: "deny", by: "ion", reason: "ion couldn't decide: Auto isn't set up" };
    const v = await this.access.decide(
      { chatId: r.chatId, projectId: r.projectId, text: r.request, roots },
      req,
    );
    return { decision: v.decision, by: "ion", reason: v.reason };
  }

  /** Resolves once the adapter's approval.requested for this id is stored, so the log stays in order. */
  private waitForRequest(requestId: string): Promise<void> {
    if (this.requested.has(`seen:${requestId}`)) return Promise.resolve();
    return new Promise((resolve) => this.requested.set(requestId, resolve));
  }
}
