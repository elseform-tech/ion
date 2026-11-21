import type { AdapterEvent } from "@ion/adapter-kit";
import { EV } from "@ion/schema";
export type Effort = "low" | "medium" | "high" | "max";
export type RunError = { code: string; retryable: boolean; message: string; retryAfterS?: number };
export type RetryState = { tries: number; effortRetried: boolean; effort: Effort | null };
export type Retry = { attempt: number; delayS: number; reason: string; effort: Effort | null };

/** At most 4 tries in all for transient failures. */
export const MAX_TRIES = 4;
const LEVELS: Effort[] = ["low", "medium", "high", "max"];
/** Failures more effort can't fix: the account, the limit, or the model itself. */
const NOT_EFFORT = new Set([
  "usage_limit",
  "billing_error",
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
  "model_not_found",
  "cloud_credential_error",
  "invalid_request",
  // Claude Code's own caps: more effort spends more, it doesn't fit in less.
  "error_max_budget_usd",
  "error_max_turns",
]);

/** Full jitter: random(0, min(120 s, 2 s × 2^attempt)); the error's retry-after wins when it has one. */
export function backoffDelay(attempt: number, random: () => number, retryAfterS?: number): number {
  // A harness's retry-after wins, capped at 120 s like our own delays; a nonsense one is ignored.
  if (retryAfterS !== undefined && Number.isFinite(retryAfterS))
    return Math.min(120, Math.max(0, retryAfterS));
  return random() * Math.min(120, 2 * 2 ** attempt);
}

/** One level up; null when already at max. No effort set counts as the harness default, and goes to high. */
export function nextEffort(e: Effort | null): Effort | null {
  if (e === null) return "high";
  return LEVELS[LEVELS.indexOf(e) + 1] ?? null;
}

/**
 * What to do after a failed try: transient errors back off (up to MAX_TRIES tries), a real failure gets one
 * retry at the next effort level, anything else stops (null).
 */
export function retryPlan(s: RetryState, err: RunError | null, random: () => number): Retry | null {
  if (!err) return null;
  if (err.retryable) {
    if (s.tries >= MAX_TRIES) return null;
    return {
      attempt: s.tries,
      delayS: backoffDelay(s.tries, random, err.retryAfterS),
      reason: err.message,
      effort: s.effort,
    };
  }
  const effort = nextEffort(s.effort);
  if (s.effortRetried || !effort || NOT_EFFORT.has(err.code)) return null;
  return { attempt: s.tries, delayS: 0, reason: err.message, effort };
}

/** How a try ended: the harness's status, and its error if any. */
export type TryEnd = { status: string; error: RunError | null };

/**
 * Notes how a try ends; false for the events the daemon keeps back: the harness's run.finished (whether the run
 * ends or retries is decided above) and a refused resume (ion retries with the history instead).
 */
export function keep(e: AdapterEvent, end: TryEnd): boolean {
  if (e.type === EV.runFinished) {
    end.status = String((e.data as { status: string }).status);
    return false;
  }
  if (e.type !== EV.error) return true;
  end.error = e.data as RunError;
  return end.error.code !== "resume_failed";
}
