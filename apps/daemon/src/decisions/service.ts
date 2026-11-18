import { randomBytes } from "node:crypto";
import { type DecisionScope, EV } from "@ion/schema";
import { UserError } from "../api/errors.js";
import type { Scope } from "../mcp/index.js";
import type { NeedsService } from "../needs/index.js";
import type { Db, EventStore } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { decisionsView } from "../views/decisions.js";
import type { AskInput, Matcher } from "./match.js";

const ASKED = "Asked. End your turn now; the answer comes as the next message.";
const OUTCOMES_PER_RUN = 3;
const FOR_JUDGE = 10;
const BUSY = "This chat is already running";

type Deps = {
  store: EventStore;
  db: Db;
  needs: NeedsService;
  /** Matches a new question to your "always" decisions; without it, every question goes to you. */
  match?: Matcher;
  /** Starts a run in the chat with this message (on the chat's harness); resolves to its run id. */
  followUp: (chatId: string, harness: string | null, text: string) => Promise<string | null>;
};

type Recorded = {
  chatId: string;
  runId: string | null;
  needId: string;
  projectId: string;
  question: string;
  choice: string;
  scope: DecisionScope;
  by: "you" | "ion";
  from?: { decisionId: string; decidedAt: string };
};

/**
 * Agents ask you instead of being approved. A question waits under Needs you; your answer becomes a decision
 * (this chat, this project or everywhere) and the chat's next message. ion answers for you only from a decision
 * you made for the project or everywhere, and only with one of the new question's own choices.
 */
export class Decisions {
  /** Runs started by an answer: their end is the decision's first outcome. */
  private readonly followRuns = new Map<string, string>();
  /** Answers waiting for their chat's current run to end. */
  private readonly waiting = new Map<string, () => void>();
  private readonly reported = new Map<string, number>();

  constructor(private readonly d: Deps) {
    d.store.onAppend((e) => {
      if (e.type !== EV.runFinished) return;
      const status = (e.data as { status: string }).status;
      const decisionId = e.runId ? this.followRuns.get(e.runId) : undefined;
      if (decisionId && (status === "done" || status === "failed"))
        this.outcome(e.chatId, { decisionId, kind: status === "done" ? "ran" : "failed", by: "ion" });
      const next = e.chatId ? this.waiting.get(e.chatId) : undefined;
      if (next && e.chatId) {
        this.waiting.delete(e.chatId);
        queueMicrotask(next);
      }
    });
  }

  async ask(s: Scope, q: AskInput): Promise<string> {
    const labels = q.choices.map((c) => c.label);
    if (new Set(labels).size !== labels.length) throw new UserError("Give each choice its own label");
    const known = await this.fromPast(s, q);
    if (known) return known;
    this.d.needs.raiseAsk({ chatId: s.chatId, runId: s.runId, ...q });
    return ASKED;
  }

  /** Your answer: choice number `n` (1-based) of an open question. */
  async answer(needId: string, n: number, scope: DecisionScope = "chat"): Promise<void> {
    const need = this.d.needs.openNeed(needId);
    const asked = this.d.needs.open(need.chatId).find((x) => x.needId === needId);
    if (need.kind !== "ask" || !asked?.choices) throw new UserError("That isn't a question");
    const choice = asked.choices[n - 1];
    if (!Number.isInteger(n) || !choice) throw new UserError(`Pick 1 to ${asked.choices.length}`);
    this.d.needs.answered(needId, choice.label, scope);
    const projectId = asked.projectId ?? "";
    const base = { chatId: need.chatId, runId: need.runId, needId, projectId, question: asked.summary };
    const decisionId = this.record({ ...base, choice: choice.label, scope, by: "you" });
    const text = `You asked: ${JSON.stringify(asked.summary)}. The user chose: ${JSON.stringify(choice.label)}.`;
    await this.send(need.chatId, text, decisionId);
  }

  /** An outcome the agent reports (at most 3 per run), for a decision it may see. */
  report(s: Scope, decisionId: string, text: string): void {
    if (!decisionsView.applicable(this.d.db, s.projectId, s.chatId).some((x) => x.decisionId === decisionId))
      throw new UserError("Not allowed");
    const n = (this.reported.get(s.runId) ?? 0) + 1;
    if (n > OUTCOMES_PER_RUN) throw new UserError("That's enough outcomes for one run");
    this.reported.set(s.runId, n);
    this.outcome(s.chatId, { decisionId, kind: "note", by: "agent", text });
  }

  /** Your own note on a decision. */
  note(decisionId: string, text: string): void {
    this.mustFind(decisionId);
    this.outcome(null, { decisionId, kind: "note", by: "you", text });
  }

  forget(decisionId: string): void {
    this.mustFind(decisionId);
    this.d.store.append({
      chatId: null,
      runId: null,
      origin: "daemon",
      type: EV.decisionForgotten,
      data: { decisionId },
    });
  }

  /** Your newest decisions that apply in this chat, one line each, for the judge. */
  forJudge(projectId: string, chatId: string): string[] {
    return decisionsView
      .applicable(this.d.db, projectId, chatId)
      .slice(0, FOR_JUDGE)
      .map((x) => `${JSON.stringify(x.question)} → ${JSON.stringify(x.choice)} (${x.scope})`);
  }

  /** ion's answer from an "always" decision, when the matcher names one of this question's own choices. */
  private async fromPast(s: Scope, q: AskInput): Promise<string | null> {
    const past = decisionsView.applicable(this.d.db, s.projectId, s.chatId).filter((x) => x.scope !== "chat");
    if (!this.d.match || past.length === 0) return null;
    const m = await this.d.match(q, past);
    const from = past.find((x) => x.decisionId === m?.decisionId);
    if (!m || !from || !q.choices.some((c) => c.label === m.label)) return null;
    this.record({
      ...{ chatId: s.chatId, runId: s.runId, needId: "", projectId: s.projectId, question: q.question },
      ...{ choice: m.label, scope: "chat", by: "ion", from },
    });
    return `The user already decided: ${JSON.stringify(m.label)} (their decision ${from.decisionId}). Go ahead.`;
  }

  private record(r: Recorded): string {
    const decisionId = `d${randomBytes(4).toString("hex")}`;
    const { chatId, runId, from, ...rest } = r;
    const data = {
      decisionId,
      ...rest,
      ...(from ? { fromDecision: from.decisionId, fromDecidedAt: from.decidedAt } : {}),
    };
    this.d.store.append({ chatId, runId, origin: "daemon", type: EV.decisionRecorded, data });
    return decisionId;
  }

  /** Starts the run that carries your answer; if the chat is busy, once its run ends. */
  private async send(chatId: string, text: string, decisionId: string): Promise<void> {
    const harness = chatsView.session(this.d.db, chatId)?.harness ?? null;
    try {
      const runId = await this.d.followUp(chatId, harness, text);
      if (runId) this.followRuns.set(runId, decisionId);
    } catch (e) {
      if (!(e instanceof UserError) || e.message !== BUSY) throw e;
      this.waiting.set(chatId, () => void this.send(chatId, text, decisionId).catch(() => {}));
    }
  }

  private outcome(
    chatId: string | null,
    o: { decisionId: string; kind: "ran" | "failed" | "note"; by: string; text?: string },
  ) {
    const said = o.text ?? (o.kind === "ran" ? "Ran after your answer" : "Failed after your answer");
    this.d.store.append({
      chatId,
      runId: null,
      origin: "daemon",
      type: EV.decisionOutcome,
      data: { decisionId: o.decisionId, kind: o.kind, text: said.slice(0, 2000), by: o.by },
    });
  }

  private mustFind(decisionId: string): void {
    if (!decisionsView.find(this.d.db, decisionId)) throw new UserError(`Unknown decision: ${decisionId}`);
  }
}
