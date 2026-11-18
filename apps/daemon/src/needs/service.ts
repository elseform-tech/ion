import { randomBytes } from "node:crypto";
import { EV, type NeedInfo } from "@ion/schema";
import { UserError } from "../api/errors.js";
import type { Db, EventStore } from "../store/index.js";
import { needsView } from "../views/needs.js";

/** "Needs you" items: questions agents ask you. A need is answered exactly once. */
export class NeedsService {
  constructor(
    private readonly store: EventStore,
    private readonly db: Db,
  ) {}

  /** An agent's question: raised and left open (the agent ends its turn); answered with `answered`. */
  raiseAsk(r: {
    chatId: string;
    runId: string;
    question: string;
    choices: { label: string; consequence: string }[];
    why?: string;
  }): string {
    const needId = `n${randomBytes(3).toString("hex")}`;
    this.store.append({
      chatId: r.chatId,
      runId: r.runId,
      origin: "daemon",
      type: EV.needRaised,
      data: {
        needId,
        requestId: `ask_${needId}`,
        kind: "ask",
        summary: r.question,
        detail: r.why ?? null,
        dedupeKey: `ask:${needId}`,
        choices: r.choices,
      },
    });
    return needId;
  }

  /** Your answer to a question: the choice's label and how far it reaches. */
  answered(needId: string, choice: string, scope: "chat" | "project" | "everywhere"): void {
    const need = this.openNeed(needId);
    this.store.append({
      chatId: need.chatId,
      runId: need.runId,
      origin: "daemon",
      type: EV.needResolved,
      data: { needId, decision: "answered", by: "you", choice, scope },
    });
  }

  /** The need, if it's still open; otherwise why it can't be answered. */
  openNeed(needId: string): { runId: string; chatId: string; kind: string } {
    const need = needsView.find(this.db, needId);
    if (!need) throw new UserError(`Unknown need: ${needId}`);
    if (!need.open)
      throw new UserError(need.decision === "superseded" ? "That run stopped" : "That's already answered");
    return need;
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
