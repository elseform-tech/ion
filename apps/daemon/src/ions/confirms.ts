import { randomBytes } from "node:crypto";
import { EV, type IonCard } from "@ion/schema";
import { UserError } from "../api/errors.js";
import type { EventStore } from "../store/index.js";

/** What waits for your click: the question, its button, and what Save (or Run) does, with the one line it says. */
export type Confirm = { question: string; yes: string; act: () => Promise<string> };

/**
 * One-click confirms in an ion's thread (security scan, 2026-11-24): what an ion's model can't do alone (save where
 * chats run, run a chat on an agent you avoid) is a card with your answer; only your click (suggestion.answer) does
 * it. Kept while ion runs: one left from before a restart is gone, and says so.
 */
export class Confirms {
  private readonly waiting = new Map<string, Confirm & { ionId: string }>();

  constructor(
    private readonly d: {
      store: EventStore;
      say: (ionId: string, text: string, card?: IonCard) => void;
    },
  ) {}

  /** Raises the card in the ion's thread; returns its id. */
  ask(ionId: string, c: Confirm): string {
    // Can't be guessed (security scan, 2026-11-24).
    const suggestionId = `k${randomBytes(16).toString("hex")}`;
    this.waiting.set(suggestionId, { ...c, ionId });
    this.d.say(ionId, c.question, { kind: "confirm", suggestionId, question: c.question, yes: c.yes });
    return suggestionId;
  }

  owns(id: string): boolean {
    return this.waiting.has(id);
  }

  /** Your answer: Save (or Run) does it and says what came of it; Not now does nothing. Each card once. */
  async answer(id: string, keep: boolean): Promise<void> {
    const c = this.waiting.get(id);
    if (!c) throw new UserError("That's gone");
    this.waiting.delete(id);
    this.d.store.append({
      chatId: `ion:${c.ionId}`,
      runId: null,
      origin: "daemon",
      type: EV.suggestionAnswered,
      data: { suggestionId: id, keep },
    });
    if (keep) this.d.say(c.ionId, await c.act());
  }
}
