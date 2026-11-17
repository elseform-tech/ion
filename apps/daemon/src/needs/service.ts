import { randomBytes } from "node:crypto";
import type { Decision } from "@ion/adapter-kit";
import { EV, type NeedInfo } from "@ion/schema";
import { UserError } from "../api/errors.js";
import type { Db, EventStore } from "../store/index.js";
import { needsView } from "../views/needs.js";

export type RaiseRequest = {
  chatId: string;
  runId: string;
  requestId: string;
  kind: string;
  summary: string;
  detail?: string | null;
  dedupeKey: string;
};

/**
 * "Needs you" items. A need resolves exactly once; that's the only thing that resumes a paused run.
 * Waiters are resolved from the stored need.resolved event, so every surface (CLI, app) sees the same answer.
 */
export class NeedsService {
  private readonly waiters = new Map<string, ((d: Decision) => void)[]>();

  constructor(
    private readonly store: EventStore,
    private readonly db: Db,
  ) {
    store.onAppend((e) => {
      if (e.type !== EV.needResolved) return;
      const { needId, decision } = e.data as { needId: string; decision: Decision | "superseded" };
      const list = this.waiters.get(needId) ?? [];
      this.waiters.delete(needId);
      for (const w of list) w(decision === "superseded" ? "deny" : decision);
    });
  }

  /** Raises a need (or joins an open one with the same dedupeKey in the chat) and waits for its answer. */
  raise(r: RaiseRequest): Promise<Decision> {
    let needId = needsView.openByKey(this.db, r.chatId, r.dedupeKey);
    if (!needId) {
      needId = `n${randomBytes(3).toString("hex")}`;
      this.store.append({
        chatId: r.chatId,
        runId: r.runId,
        origin: "daemon",
        type: EV.needRaised,
        data: {
          needId,
          requestId: r.requestId,
          kind: r.kind,
          summary: r.summary,
          detail: r.detail ?? null,
          dedupeKey: r.dedupeKey,
        },
      });
    }
    const id = needId;
    return new Promise((resolve) => this.waiters.set(id, [...(this.waiters.get(id) ?? []), resolve]));
  }

  resolve(needId: string, decision: Decision, by: "you" | "ion"): void {
    const need = needsView.find(this.db, needId);
    if (!need) throw new UserError(`Unknown need: ${needId}`);
    if (!need.open)
      throw new UserError(need.decision === "superseded" ? "That run stopped" : "That's already answered");
    this.store.append({
      chatId: this.chatOf(needId),
      runId: need.runId,
      origin: "daemon",
      type: EV.needResolved,
      data: { needId, decision, by },
    });
  }

  /** The run stopped (interrupt, shutdown, crash): its open needs can't be answered any more. */
  supersedeRun(runId: string): void {
    for (const needId of needsView.openForRun(this.db, runId))
      this.store.append({
        chatId: this.chatOf(needId),
        runId,
        origin: "daemon",
        type: EV.needResolved,
        data: { needId, decision: "superseded", by: "daemon" },
      });
  }

  open(chatId?: string): NeedInfo[] {
    return needsView.open(this.db, chatId);
  }

  private chatOf(needId: string): string | null {
    return needsView.open(this.db).find((n) => n.needId === needId)?.chatId ?? null;
  }
}
