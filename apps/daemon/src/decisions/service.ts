import { createHash, randomBytes } from "node:crypto";
import { type DecisionInfo, type DecisionScope, EV, type NeedInfo } from "@ion/schema";
import { UserError } from "../api/errors.js";
import type { Scope } from "../mcp/index.js";
import type { NeedsService } from "../needs/index.js";
import type { Db, EventStore } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { decisionsView } from "../views/decisions.js";
import { runsView } from "../views/runs.js";
import {
  actionOf,
  type Blocked,
  BLOCKED_WAIT_MS,
  blockedAnswer,
  blockedQuestion,
  type Held,
  Holds,
} from "./blocked.js";
import { FollowUps, type Message, type Start } from "./followups.js";
import type { AskInput, Matcher } from "./match.js";
import { overlap, SAME_QUESTION } from "./words.js";
import type { IonQuestions } from "../ions/questions.js";

const keyHash = (key: string) => createHash("sha256").update(key).digest("hex");

/** An "allow" answer about a stopped call: kept as an exact rule, never handed to the judge. */
const isAllowAnswer = (choice: string) =>
  choice === "Always allow in this project" || choice === "Allow once";

/** The message your answer becomes in the chat: a choice, or your own words. */
const followText = (question: string, answer: string, custom = false) =>
  `You asked: ${JSON.stringify(question)}. The user ${custom ? "answered" : "chose"}: ${JSON.stringify(answer)}.`;

/**
 * What the agent is told after your answer about a stopped call: your own words, or (late: its call was already
 * refused) that it may go ahead now. Otherwise nothing: its call simply ran or didn't.
 */
function blockedFollowText(
  question: string,
  a: { custom: boolean; label: string; late: boolean },
): string | null {
  if (a.custom) return followText(question, a.label, true);
  return a.late
    ? `Earlier ion stopped this: ${JSON.stringify(actionOf(question))}. The user now allows it.`
    : null;
}

/** Your answer: choice number `pick` (1-based), or your own words when none of the choices fit. */
function answerOf(pick: number | string, choices: { label: string }[]): { label: string; custom: boolean } {
  if (typeof pick === "string") {
    const words = pick.trim().slice(0, 2000);
    if (!words) throw new UserError("Say what you'd like");
    return { label: words, custom: true };
  }
  const choice = choices[pick - 1];
  if (!Number.isInteger(pick) || !choice) throw new UserError(`Pick 1 to ${choices.length}`);
  return { label: choice.label, custom: false };
}

const ASKED = "Asked. End your turn now; the answer comes as the next message.";
const OUTCOMES_PER_RUN = 3;
const FOR_JUDGE = 10;
const ION_ANSWERS_PER_RUN = 3;

type Deps = {
  store: EventStore;
  db: Db;
  needs: NeedsService;
  /** Matches a new question to your "always" decisions; without it, every question goes to you. */
  match?: Matcher;
  /**
   * Starts a run in the chat with this message (on the chat's harness); resolves to its run id. `request` is what
   * the judge treats as your request: yours from the run that asked, never the agent's question.
   */
  followUp: Start;
  /** What you asked in a running run (the judge's "request"), or null. */
  requestOf?: (runId: string) => string | null;
  /** How long a tool call ion stopped waits for your answer (4 minutes; shorter in tests). */
  blockedWaitMs?: number;
  /** Questions in threads ion started go through the project's ion first (Plan 09). */
  ion?: IonQuestions;
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
  /** Your own words rather than one of the agent's choices. */
  custom?: boolean;
  /** About a tool call ion stopped, not an agent's question. */
  blocked?: boolean;
  from?: { decisionId: string; decidedAt: string };
};

/**
 * Agents ask you instead of being approved. A question waits under Needs you; your answer becomes a decision
 * (this chat, this project or everywhere) and the chat's next message. ion answers for you only from a decision
 * you made for the project or everywhere, and only with one of the new question's own choices.
 */
export class Decisions {
  private readonly followUps: FollowUps;
  /** Questions being answered right now, so two answers can't both start a run. */
  private readonly answering = new Set<string>();
  private readonly reported = new Map<string, number>();
  private readonly ionAnswered = new Map<string, number>();
  /** Your request in the run that asked each question, kept for the run your answer starts. */
  private readonly requests = new Map<string, string>();
  /** Tool calls ion stopped, waiting on your answer. */
  private readonly holds: Holds;
  /** Each stopped call's exact key (hashed), for an "Always allow" answer. */
  private readonly keys = new Map<string, string>();

  constructor(private readonly d: Deps) {
    this.holds = new Holds(d.blockedWaitMs ?? BLOCKED_WAIT_MS);
    this.followUps = new FollowUps(d.store, d.followUp, (chatId, decisionId, how) =>
      this.outcome(chatId, {
        decisionId,
        kind: how.ok ? "ran" : "failed",
        by: "ion",
        ...(how.why ? { text: how.why } : {}),
      }),
    );
  }

  async ask(s: Scope, q: AskInput): Promise<string> {
    const labels = q.choices.map((c) => c.label);
    if (new Set(labels).size !== labels.length) throw new UserError("Give each choice its own label");
    if (q.choices.filter((c) => c.recommended).length > 1)
      throw new UserError("Recommend one option at most");
    const known = await this.fromPast(s, q);
    if (known) return known;
    const extra = this.d.ion?.isThread(s.chatId) ? await this.d.ion.raiseWith(s, q) : {};
    const needId = this.d.needs.raiseAsk({ chatId: s.chatId, runId: s.runId, ...q, ...extra });
    this.requests.set(needId, this.d.requestOf?.(s.runId) ?? "");
    return ASKED;
  }

  /**
   * ion stopped a tool call (the judge said no, or couldn't decide): ask you, and hold the call until you answer
   * or 4 minutes pass ("timeout": the call is refused, the question stays open, and a later yes still counts).
   */
  askBlocked(s: Scope, b: Blocked): Promise<Held> {
    const q = blockedQuestion(b);
    const needId = this.d.needs.raiseAsk({
      chatId: s.chatId,
      runId: s.runId,
      ...q,
      blocked: { requestId: b.requestId },
    });
    this.requests.set(needId, this.d.requestOf?.(s.runId) ?? "");
    this.keys.set(needId, keyHash(b.key));
    return this.holds.hold(needId);
  }

  /** Whether you said "Always allow" for exactly this action (tool and input) in this project. */
  alwaysAllowed(projectId: string, _chatId: string, key: string): boolean {
    return decisionsView.allows(this.d.db, projectId, keyHash(key));
  }

  /**
   * Your answer: choice number `n` (1-based) of an open question. The run that carries it starts first: if it
   * can't (the agent signed out, the chat archived…) the question stays open and you can answer again. A busy
   * chat gets it when its run ends.
   */
  async answer(needId: string, pick: number | string, scope: DecisionScope = "chat"): Promise<void> {
    if (this.answering.has(needId)) throw new UserError("That's already answered");
    const need = this.d.needs.openNeed(needId);
    // A question held behind one waiting elsewhere is answered too (with that answer).
    const asked = this.d.needs.open(need.chatId, true).find((x) => x.needId === needId);
    if (need.kind !== "ask" || !asked?.choices) throw new UserError("That isn't a question");
    const { label, custom } = answerOf(pick, asked.choices);
    if (asked.blocked) return this.answerBlocked(asked, pick, label);
    this.answering.add(needId);
    try {
      // After a restart the request is gone: the judge then gets none, which only makes it stricter.
      const m: Message = {
        harness: this.harnessOf(need.runId, need.chatId),
        text: followText(asked.summary, label, custom),
        request: this.requests.get(needId) ?? "",
        shown: label,
      };
      const started = await this.followUps.tryNow(need.chatId, m);
      this.d.needs.answered(needId, label, scope);
      this.requests.delete(needId);
      const base = { chatId: need.chatId, runId: need.runId, needId, projectId: asked.projectId ?? "" };
      const decisionId = this.record({
        ...base,
        question: asked.summary,
        choice: label,
        scope,
        by: "you",
        ...(custom ? { custom } : {}),
      });
      if (started === "busy") this.followUps.later(need.chatId, { ...m, decisionId });
      else if (started) this.followUps.started(started, decisionId);
      if (this.d.ion?.isThread(need.chatId))
        await this.d.ion.afterAnswer(
          { needId, projectId: base.projectId, question: asked.summary, choice: label },
          (id, n) => this.answer(id, n, "chat"),
        );
    } finally {
      this.answering.delete(needId);
    }
  }

  /**
   * Your answer about a stopped tool call. A call still waiting runs or is refused at once; "Always allow" lets
   * exactly this action run in the project from now on, and "Don't allow" is kept for the chat. The agent hears
   * about it only when it can't otherwise know: your own words, or a yes after its call was already refused.
   */
  private async answerBlocked(asked: NeedInfo, pick: number | string, label: string): Promise<void> {
    const custom = typeof pick === "string";
    const { allow, scope } = blockedAnswer(label, custom);
    this.d.needs.answered(asked.needId, label, scope ?? "chat");
    const decisionId = scope ? this.recordBlocked(asked, { label, scope, custom }) : undefined;
    const waited = this.holds.release(asked.needId, allow ? "allow" : "deny");
    const text = blockedFollowText(asked.summary, { custom, label, late: !waited && allow });
    const request = this.requests.get(asked.needId) ?? "";
    this.requests.delete(asked.needId);
    if (text)
      await this.deliver(
        asked.chatId,
        { harness: this.harnessOf(asked.runId, asked.chatId), text, request, shown: label },
        decisionId,
      );
  }

  /** Your answer about a stopped call, kept; "Always allow" with the exact action's key, never the question's words. */
  private recordBlocked(
    asked: NeedInfo,
    a: { label: string; scope: "chat" | "project"; custom: boolean },
  ): string {
    const allowKey = a.scope === "project" ? this.keys.get(asked.needId) : undefined;
    return this.record({
      ...{ chatId: asked.chatId, runId: asked.runId, needId: asked.needId, projectId: asked.projectId ?? "" },
      ...{ question: asked.summary, choice: a.label, scope: a.scope, by: "you", blocked: true },
      ...(allowKey ? { allowKey } : {}),
      ...(a.custom ? { custom: true } : {}),
    });
  }

  /** Sends a message into the chat now, or after its current run if it's busy. */
  private async deliver(chatId: string, m: Message, decisionId?: string): Promise<void> {
    const started = await this.followUps.tryNow(chatId, m);
    if (started === "busy") this.followUps.later(chatId, { ...m, ...(decisionId ? { decisionId } : {}) });
    else if (started) this.followUps.started(started, decisionId);
  }

  /** After a restart: answers recorded but never sent into their chat (it was busy when ion stopped) go now. */
  async resume(): Promise<void> {
    for (const chat of chatsView.list(this.d.db))
      for (const p of this.unsent(chat.chatId)) {
        const started = await this.followUps.tryNow(chat.chatId, p).catch(() => null);
        if (started === "busy") this.followUps.later(chat.chatId, p);
        else if (started) this.followUps.started(started, p.decisionId);
      }
  }

  /** Your answers in a chat whose message never reached it. */
  private unsent(chatId: string): (Message & { decisionId: string })[] {
    const events = this.d.store.read({ chatId });
    const sent = (needId: string, text: string) => {
      const from = events.findIndex(
        (x) => x.type === EV.needRaised && (x.data as { needId: string }).needId === needId,
      );
      return events
        .slice(from)
        .some((x) => x.type === EV.messageSent && (x.data as { text: string }).text === text);
    };
    return events.flatMap((e) => {
      const d = e.data as {
        decisionId: string;
        needId: string;
        question: string;
        choice: string;
        by: string;
        custom?: boolean;
        blocked?: boolean;
      };
      if (e.type !== EV.decisionRecorded || d.by !== "you" || !d.needId || d.blocked) return [];
      const text = followText(d.question, d.choice, d.custom === true);
      if (sent(d.needId, text)) return [];
      const harness = this.harnessOf(e.runId, chatId);
      return [{ harness, text, request: "", shown: d.choice, decisionId: d.decisionId }];
    });
  }

  /** The agent that asked (never a default one): the asking run's harness, else the chat's last session's. */
  private harnessOf(runId: string | null, chatId: string): string | null {
    const run = runId ? runsView.rows(this.d.db).find((r) => r.runId === runId) : undefined;
    return run?.harness ?? chatsView.session(this.d.db, chatId)?.harness ?? null;
  }

  /** An outcome the agent reports (at most 3 per run), for a decision it may see. */
  report(s: Scope, decisionId: string, text: string): void {
    // Only decisions of the agent's own project: an agent can't annotate another project's decisions.
    const mine = decisionsView.find(this.d.db, decisionId);
    if (!mine || mine.projectId !== s.projectId || (mine.scope === "chat" && mine.chatId !== s.chatId))
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
      .filter((x) => x.by === "you" && !isAllowAnswer(x.choice))
      .slice(0, FOR_JUDGE)
      .map((x) => `${JSON.stringify(x.question)} → ${JSON.stringify(x.choice)} (${x.scope})`);
  }

  /** ion's answer from an "always" decision, when the matcher names one of this question's own choices. */
  private async fromPast(s: Scope, q: AskInput): Promise<string | null> {
    // In a thread ion started, any of your decisions in the project counts; in your own chats, only "always" ones.
    const thread = this.d.ion?.isThread(s.chatId) ?? false;
    const past = this.pastFor(s, thread);
    if (!this.d.match || past.length === 0 || (this.ionAnswered.get(s.runId) ?? 0) >= ION_ANSWERS_PER_RUN)
      return null;
    const m = await this.d.match(q, past);
    const from = past.find((x) => x.decisionId === m?.decisionId);
    // Only the very label you picked, offered again as one of the new choices.
    if (!m || !from || m.label !== from.choice || !q.choices.some((c) => c.label === m.label)) return null;
    // The model only picks; the new question must also be worded much like the one you answered.
    if (overlap(q.question, from.question) < SAME_QUESTION) return null;
    this.ionAnswered.set(s.runId, (this.ionAnswered.get(s.runId) ?? 0) + 1);
    this.record({
      ...{ chatId: s.chatId, runId: s.runId, needId: "", projectId: s.projectId, question: q.question },
      ...{ choice: m.label, scope: "chat", by: "ion", from },
    });
    if (thread) this.d.ion?.answeredFor(s.projectId, q.question, m.label);
    return `The user already decided: ${JSON.stringify(m.label)} when asked ${JSON.stringify(from.question)}. Go ahead.`;
  }

  private pastFor(s: Scope, thread: boolean) {
    const mine = (x: DecisionInfo) => x.by === "you" && (thread || x.scope !== "chat");
    if (!thread) return decisionsView.applicable(this.d.db, s.projectId, s.chatId).filter(mine);
    return decisionsView.list(this.d.db, s.projectId).filter(mine);
  }

  /** Your answer to an ion's "always?" suggestion: kept, it's a decision for the project. */
  suggestion(suggestionId: string, keep: boolean): void {
    const s = this.d.ion?.takeSuggestion(suggestionId);
    if (!s) throw new UserError("That suggestion is gone");
    const chatId = `ion:${s.projectId}`;
    this.d.store.append({
      chatId,
      runId: null,
      origin: "daemon",
      type: EV.suggestionAnswered,
      data: { suggestionId, keep },
    });
    if (keep)
      this.record({
        ...{ chatId, runId: null, needId: "", projectId: s.projectId, question: s.question },
        ...{ choice: s.choice, scope: "project", by: "you" },
      });
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
