/**
 * A tool call ion stopped, waiting on you: its request, what it does, why ion stopped it, its full input, and its
 * exact key (tool and input) for "Always allow".
 */
export type Blocked = {
  requestId: string;
  summary: string;
  reason: string;
  input?: string;
  key: string;
  /** The input shown was cut: "Always allow" would cover text you can't see, so it isn't offered. */
  cut?: boolean;
  /** A guess of ion's, not the judge's no (the user, 2026-11-21): "ion is wary of this". */
  wary?: true;
  /** A repo's server that runs the repo's own code, before a chat starts it: asked as it is, for this chat only. */
  repo?: true;
};
export type Held = "allow" | "deny" | "timeout";

/** How long a stopped tool call waits for your answer before ion says no (the user's choice: 4 minutes). */
export const BLOCKED_WAIT_MS = 4 * 60_000;

const PREFIX = "Allow this? ";
const ONCE = "Allow once";
const ALWAYS = "Always allow in this project";
const NO = "Don't allow";
const FOR_CHAT = "Allow for this chat";
const REPO_NO = "No";

/** A repo's server that runs the repo's own code: the summary says what, its command is the why. */
const repoQuestion = (b: Blocked) => ({
  question: b.summary,
  why: b.reason,
  choices: [
    { label: FOR_CHAT, consequence: "It runs in this chat. ion asks again in another chat." },
    { label: REPO_NO, consequence: "This chat goes on without it." },
  ],
});

/**
 * Whether the input says more than the question's title: not when it's only the command the title already shows,
 * with at most the agent's description of it (tour, final review, 2026-11-21: raw JSON followed the reason). Any other
 * field (a timeout, running in the background) and a cut input always show: "Always allow" covers them.
 */
function addsToTitle(b: Blocked): boolean {
  if (!b.input) return false;
  try {
    const o = JSON.parse(b.input) as Record<string, unknown>;
    const extra = Object.keys(o ?? {}).filter((k) => k !== "command" && k !== "description");
    return o?.command !== b.summary || extra.length > 0;
  } catch {
    return true;
  }
}

/** What you're asked about a stopped tool call (or a repo's server about to start). */
export const blockedQuestion = (b: Blocked) => (b.repo ? repoQuestion(b) : callQuestion(b));

const callQuestion = (b: Blocked) => ({
  question: `${PREFIX}${b.summary}`,
  why: [
    `${b.wary ? "ion is wary of this" : "ion stopped it"}: ${b.reason}`,
    ...(addsToTitle(b) ? [b.input] : []),
  ].join("\n\n"),
  choices: [
    { label: ONCE, consequence: "It runs this time. ion asks again next time." },
    ...(b.cut
      ? []
      : [
          {
            label: ALWAYS,
            consequence: "It runs, and this exact action runs in this project from now on without asking.",
          },
        ]),
    { label: NO, consequence: "The agent is told no and works around it." },
  ],
});

/** The action a blocked question is about, from its question. */
export const actionOf = (question: string) =>
  question.startsWith(PREFIX) ? question.slice(PREFIX.length) : question;

/**
 * Your answer to a stopped call, by the label you picked: whether it runs, and how far the answer reaches (null:
 * not kept). Your own words aren't a yes; they're sent to the agent as you said them.
 */
export function blockedAnswer(
  label: string,
  custom: boolean,
): { allow: boolean; scope: "chat" | "project" | null } {
  if (custom) return { allow: false, scope: "chat" };
  if (label === ONCE || label === FOR_CHAT) return { allow: true, scope: null }; // once means once
  if (label === ALWAYS) return { allow: true, scope: "project" };
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
