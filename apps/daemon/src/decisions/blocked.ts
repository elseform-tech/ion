import { stripControl } from "@ion/schema";
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
  /** The judge said it's missing information, not that it's risky (the user, 2026-11-21): "ion isn't sure". */
  unsure?: true;
  /** The judge gave no verdict (failed, slow): "ion couldn't decide" (task review, 2026-11-21). */
  undecided?: true;
  /** A repo's server that runs the repo's own code, before a chat starts it: asked as it is, for this chat only. */
  repo?: true;
};
export type Held = "allow" | "deny" | "timeout";

/** How long a stopped tool call waits for your answer before ion says no (the user's choice: 4 minutes). */
export const BLOCKED_WAIT_MS = 4 * 60_000;

const PREFIX = "Allow this? ";
const ALLOW = "Allow";
const NO = "Don't allow";
const FOR_CHAT = "Allow for this chat";
const REPO_NO = "No";

const REPO_WHY = 600;

/** A repo's server that runs the repo's own code: the summary says what, its command (as text, capped) is the why. */
const repoQuestion = (b: Blocked) => ({
  question: stripControl(b.summary),
  why: stripControl(b.reason).slice(0, REPO_WHY),
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

/** Why ion asks, in plain words: its own guess, the judge unsure, or the judge's no. */
const whyWord = (b: Blocked) => {
  if (b.wary) return "ion is wary of this";
  if (b.undecided) return "ion couldn't decide";
  return b.unsure ? "ion isn't sure" : "ion thinks this is risky";
};

/** Why, then the reason; a reason that already says ion couldn't decide is said once (final review, 2026-11-22). */
const whyLine = (b: Blocked) =>
  b.undecided && b.reason.startsWith("ion couldn't decide") ? b.reason : `${whyWord(b)}: ${b.reason}`;

const callQuestion = (b: Blocked) => ({
  question: `${PREFIX}${b.summary}`,
  why: [whyLine(b), ...(addsToTitle(b) ? [b.input] : [])].join("\n\n"),
  // Remember (the user, 2026-11-21) keeps either answer for this exact action in this project; a cut input can't be
  // remembered (you don't see all of it).
  choices: [
    { label: ALLOW, consequence: "It runs." },
    { label: NO, consequence: "The agent is told no and works around it." },
  ],
});

/** The action a blocked question is about, from its question. */
export const actionOf = (question: string) =>
  question.startsWith(PREFIX) ? question.slice(PREFIX.length) : question;

/**
 * Your answer to a stopped call, by the label you picked and whether you ticked Remember: whether it runs, how far the
 * answer reaches (null: not kept), and whether it's remembered for this exact action in this project. Your own words
 * aren't a yes; they're sent to the agent as you said them, and never remembered.
 */
export function blockedAnswer(
  label: string,
  custom: boolean,
  remember = false,
): { allow: boolean; scope: "chat" | "project" | null; remember: boolean } {
  if (custom) return { allow: false, scope: "chat", remember: false };
  if (label === ALLOW || label === FOR_CHAT)
    return remember ? { allow: true, scope: "project", remember } : { allow: true, scope: null, remember };
  return { allow: false, scope: remember ? "project" : "chat", remember };
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

  /** Whether a call still waits for this answer (not yet answered, nor past the wait). */
  waits(needId: string): boolean {
    return this.waiting.has(needId);
  }

  /** True when a call was still waiting for this answer. */
  release(needId: string, h: Held): boolean {
    const r = this.waiting.get(needId);
    this.waiting.delete(needId);
    r?.(h);
    return Boolean(r);
  }
}
