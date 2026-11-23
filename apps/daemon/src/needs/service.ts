import { randomBytes } from "node:crypto";
import { EV, type HandoffLimit, type NeedInfo } from "@ion/schema";
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
    choices: { label: string; consequence: string; recommended?: boolean }[];
    why?: string;
    /** For a tool call ion stopped: its request, so the call's record and the question match. */
    blocked?: { requestId: string };
    /** A stopped call whose answer can't be remembered (its input was cut). */
    noRemember?: true;
    /** In an ion thread: the ion's note, or the question already waiting that this one is held behind. */
    via?: { note: string };
    heldFor?: string;
    /** ion's own question when the chat's agent hit its limit (runs/limit-handoff.ts). */
    limit?: HandoffLimit;
  }): string {
    const needId = `n${randomBytes(3).toString("hex")}`;
    this.store.append({
      chatId: r.chatId,
      runId: r.runId,
      origin: "daemon",
      type: EV.needRaised,
      data: {
        needId,
        requestId: r.blocked?.requestId ?? `ask_${needId}`,
        kind: "ask",
        summary: r.question,
        detail: r.why ?? null,
        dedupeKey: `ask:${needId}`,
        choices: r.choices,
        ...(r.blocked ? { blocked: true } : {}),
        ...(r.noRemember ? { noRemember: true } : {}),
        ...(r.via ? { via: r.via } : {}),
        ...(r.heldFor ? { heldFor: r.heldFor } : {}),
        ...(r.limit ? { limit: r.limit } : {}),
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
        data: { needId, decision: "superseded", by: "daemon", why: "stopped" },
      });
  }

  /** At ion's start: no call from before is still held, so their questions can't be answered any more. */
  supersedeStoppedCalls(): void {
    for (const n of needsView.open(this.db, undefined, true).filter((x) => x.blocked))
      this.store.append({
        chatId: n.chatId,
        runId: n.runId,
        origin: "daemon",
        type: EV.needResolved,
        data: { needId: n.needId, decision: "superseded", by: "daemon", why: "restarted" },
      });
  }

  open(chatId?: string, held = false): NeedInfo[] {
    return needsView.open(this.db, chatId, held);
  }

  heldFor(needId: string): NeedInfo[] {
    return needsView.heldFor(this.db, needId);
  }

  orphans(): NeedInfo[] {
    return needsView.orphans(this.db);
  }

  /** The chat was archived: its open needs, questions too, can't be answered any more. */
  supersedeChat(chatId: string): void {
    for (const n of needsView.open(this.db, chatId, true))
      this.store.append({
        chatId,
        runId: n.runId,
        origin: "daemon",
        type: EV.needResolved,
        data: { needId: n.needId, decision: "superseded", by: "daemon", why: "archived" },
      });
  }

  /** A held question raised to you after all: closed as itself, and asked again in the open. */
  release(n: NeedInfo, note: string): void {
    this.store.append({
      chatId: n.chatId,
      runId: n.runId,
      origin: "daemon",
      type: EV.needResolved,
      data: { needId: n.needId, decision: "superseded", by: "daemon", why: "asked again" },
    });
    this.raiseAsk({
      chatId: n.chatId,
      runId: n.runId,
      question: n.summary,
      choices: n.choices ?? [],
      ...(n.detail ? { why: n.detail } : {}),
      via: { note },
    });
  }

  private chatOf(needId: string): string | null {
    return needsView.open(this.db).find((n) => n.needId === needId)?.chatId ?? null;
  }
}
