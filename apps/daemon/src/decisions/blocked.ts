/**
 * A tool call ion stopped, waiting on you: its request, what it does, why ion stopped it, its full input, and its
 * exact key (tool and input) for "Always allow".
 */
export type Blocked = { requestId: string; summary: string; reason: string; input?: string; key: string };
export type Held = "allow" | "deny" | "timeout";

/** How long a stopped tool call waits for your answer before ion says no (the user's choice: 4 minutes). */
export const BLOCKED_WAIT_MS = 4 * 60_000;

const PREFIX = "Allow this? ";

/** What you're asked about a stopped tool call. */
export const blockedQuestion = (b: Blocked) => ({
  question: `${PREFIX}${b.summary}`,
  why: [`ion stopped it: ${b.reason}`, ...(b.input ? [b.input] : [])].join("\n\n"),
  choices: [
    { label: "Allow once", consequence: "It runs this time. ion asks again next time." },
    {
      label: "Always allow in this project",
      consequence: "It runs, and this exact action runs in this project from now on without asking.",
    },
    { label: "Don't allow", consequence: "The agent is told no and works around it." },
  ],
});

/** The action a blocked question is about, from its question. */
export const actionOf = (question: string) =>
  question.startsWith(PREFIX) ? question.slice(PREFIX.length) : question;

/** Your answer to a stopped call: whether it runs, and how far the answer reaches (null: not kept). */
export function blockedAnswer(pick: number | string): { allow: boolean; scope: "chat" | "project" | null } {
  if (typeof pick === "string") return { allow: false, scope: "chat" }; // your own words: not a yes; sent as said
  if (pick === 1) return { allow: true, scope: null }; // once means once
  if (pick === 2) return { allow: true, scope: "project" };
  return { allow: false, scope: "chat" };
}

/** Tool calls waiting on your answer, each released once: by your answer, or with "timeout" after the wait. */
export class Holds {
  private readonly waiting = new Map<string, (h: Held) => void>();

  constructor(private readonly waitMs: number) {}

  hold(needId: string): Promise<Held> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.release(needId, "timeout"), this.waitMs);
      this.waiting.set(needId, (h) => {
        clearTimeout(timer);
        resolve(h);
      });
    });
  }

  /** True when a call was still waiting for this answer. */
  release(needId: string, h: Held): boolean {
    const r = this.waiting.get(needId);
    this.waiting.delete(needId);
    r?.(h);
    return Boolean(r);
  }
}
