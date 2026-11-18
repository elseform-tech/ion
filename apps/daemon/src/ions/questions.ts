import { randomBytes } from "node:crypto";
import { EV, type IonCard, type NeedInfo } from "@ion/schema";
import type { AskInput } from "../decisions/match.js";
import { overlap, SAME_QUESTION } from "../decisions/words.js";
import type { NeedsService } from "../needs/index.js";
import type { Db, EventStore } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { decisionsView } from "../views/decisions.js";

/** You've given the same answer to matching questions this many times: ion suggests making it "always". */
const SUGGEST_AFTER = 3;
/** A decision whose runs failed this many times is flagged. */
const FLAG_AFTER = 2;

type Answered = { needId: string; projectId: string; question: string; choice: string };
type Suggestion = { projectId: string; question: string; choice: string };

export type IonQuestionsDeps = {
  store: EventStore;
  db: Db;
  needs: NeedsService;
  /** Which open question (its needId) is the same as this one, or null. A quick model, or none in tests. */
  same: (q: AskInput, open: NeedInfo[]) => Promise<string | null>;
};

/**
 * In threads ion started (never your own chats), a question goes through the project's ion first: it holds a
 * duplicate of a question already waiting, or passes it to you with a note; after you answer, it settles the held
 * ones, suggests "always" when you keep answering the same way, and flags decisions that keep failing.
 */
export class IonQuestions {
  private readonly suggestions = new Map<string, Suggestion>();
  /** Suggestions already answered: never offered again. */
  private readonly answeredSuggestions: Suggestion[] = [];

  constructor(private readonly d: IonQuestionsDeps) {
    d.store.onAppend((e) => {
      const data = e.data as { needId?: string; decision?: string; decisionId?: string; kind?: string };
      if (e.type === EV.needResolved && data.decision !== "answered" && data.needId)
        this.release(data.needId);
      if (e.type === EV.decisionOutcome && data.kind === "failed" && data.decisionId)
        this.flag(data.decisionId);
    });
  }

  isThread(chatId: string): boolean {
    return chatsView.list(this.d.db).some((c) => c.chatId === chatId && c.by === "ion");
  }

  /** What a question in an ion thread is raised with: held behind the same one waiting, or the ion's note. */
  async raiseWith(
    s: { chatId: string; projectId: string },
    q: AskInput,
  ): Promise<{ heldFor: string } | { via: { note: string } }> {
    const waiting = this.d.needs
      .open()
      .filter(
        (n) => n.projectId === s.projectId && n.chatId !== s.chatId && !n.blocked && this.isThread(n.chatId),
      );
    const held = waiting.length ? await this.d.same(q, waiting).catch(() => null) : null;
    if (held && waiting.some((n) => n.needId === held)) return { heldFor: held };
    return { via: { note: this.note(s.projectId, q.question) } };
  }

  /** The ion's one line of context: a similar answer you gave before, or that it's new. */
  note(projectId: string, question: string): string {
    const like = decisionsView
      .list(this.d.db, projectId)
      .filter((x) => x.by === "you" && overlap(x.question, question) >= SAME_QUESTION)
      .at(-1);
    if (!like) return `${projectId}'s ion: first time this comes up`;
    return `${projectId}'s ion: you answered a similar question "${like.choice}" on ${day(like.decidedAt)}`;
  }

  /** ion answered from one of your decisions: its ion says so. */
  answeredFor(projectId: string, question: string, choice: string): void {
    this.say(
      projectId,
      `Answered ${JSON.stringify(question)} with ${JSON.stringify(choice)} from your decision.`,
    );
  }

  /** You answered: settle the questions held behind it, and suggest "always" once you've said the same 3 times. */
  async afterAnswer(
    a: Answered,
    answerHeld: (needId: string, choice: number) => Promise<void>,
  ): Promise<void> {
    for (const h of this.d.needs.heldFor(a.needId)) {
      const n = (h.choices ?? []).findIndex((c) => c.label === a.choice);
      if (n >= 0)
        await answerHeld(h.needId, n + 1).catch(() =>
          this.d.needs.release(h, this.note(a.projectId, h.summary)),
        );
      else this.d.needs.release(h, this.note(a.projectId, h.summary));
    }
    this.suggest(a);
  }

  private suggest(a: Answered): void {
    const same = decisionsView
      .list(this.d.db, a.projectId)
      .filter(
        (x) => x.by === "you" && x.choice === a.choice && overlap(x.question, a.question) >= SAME_QUESTION,
      );
    const offered = [...this.suggestions.values(), ...this.answeredSuggestions].some(
      (x) => x.projectId === a.projectId && overlap(x.question, a.question) >= SAME_QUESTION,
    );
    if (same.length < SUGGEST_AFTER || offered) return;
    const suggestionId = `s${randomBytes(4).toString("hex")}`;
    this.suggestions.set(suggestionId, { projectId: a.projectId, question: a.question, choice: a.choice });
    this.say(a.projectId, `You've answered ${JSON.stringify(a.choice)} ${same.length} times. Always?`, {
      kind: "suggest",
      suggestionId,
      question: a.question,
      choice: a.choice,
    });
  }

  /** A suggestion you're answering (once): what it proposed, or null when it's gone (answered, or ion restarted). */
  takeSuggestion(suggestionId: string): Suggestion | null {
    const s = this.suggestions.get(suggestionId) ?? null;
    this.suggestions.delete(suggestionId);
    if (s) this.answeredSuggestions.push(s);
    return s;
  }

  /** Questions held behind one that closed without your answer are raised to you. */
  private release(needId: string): void {
    for (const h of this.d.needs.heldFor(needId))
      this.d.needs.release(h, this.note(h.projectId ?? "", h.summary));
  }

  /** A decision whose runs keep failing: its project's ion flags it, once. */
  private flag(decisionId: string): void {
    const d = decisionsView.find(this.d.db, decisionId);
    const failed = d?.outcomes.filter((o) => o.kind === "failed").length ?? 0;
    if (
      !d ||
      failed !== FLAG_AFTER ||
      !chatsView.list(this.d.db).some((c) => c.projectId === d.projectId && c.by === "ion")
    )
      return;
    this.say(
      d.projectId,
      `${JSON.stringify(d.choice)} for ${JSON.stringify(d.question)} led to ${failed} failed runs.`,
      {
        kind: "flag",
        decisionId,
        question: d.question,
        choice: d.choice,
        failed,
      },
    );
  }

  private say(projectId: string, text: string, card?: IonCard): void {
    this.d.store.append({
      chatId: `ion:${projectId}`,
      runId: null,
      origin: "daemon",
      type: EV.ionSaid,
      data: { text, ...(card ? { card } : {}) },
    });
  }
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
