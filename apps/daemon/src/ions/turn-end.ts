import type { AdapterEvent, Session } from "@ion/adapter-kit";
import { EV } from "@ion/schema";
import { cleanWhy, type IonLine, NO_AGENT, STOPPED, TOO_LONG } from "./fallback.js";
import { forgetSession, type Kept, keepSession } from "./sessions.js";

/**
 * How a turn's session ended: its last message, its native id, whether it ran past its limit, and `stuck`: it
 * didn't close in time (the agent may still hold it open).
 */
export type Ended = {
  /** When the turn's session started (ISO): a turn that ends well clears a limit mark made before it. */
  startedAt: string;
  last: string;
  nativeId: string | null;
  late: boolean;
  failed: boolean;
  /** The agent's own words for why it failed (its first error), cleaned (cleanWhy). */
  error?: string;
  stuck?: true;
  /** You stopped it (it ended as `late` does, but says so). */
  stopped?: true;
};

/** How long ion waits for a session to close: an agent that never does can't hold the turn, nor the ion's next. */
export const CLOSE_MS = 2000;

/** Closes a session, waiting at most CLOSE_MS: whether it closed in time. */
export async function closing(session: Session): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = new Promise<false>((r) => {
    timer = setTimeout(() => r(false), CLOSE_MS);
  });
  try {
    return await Promise.race([
      session.close().then(
        () => true,
        () => true,
      ),
      wait,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Notes the session's last message, and its native id once the agent says it (some only say it when it starts). */
export function note(e: AdapterEvent, end: Ended): void {
  if (e.type === EV.error) {
    end.failed = true;
    const why = cleanWhy(String((e.data as { message?: unknown }).message ?? ""));
    if (why && !end.error) end.error = why;
  }
  if (e.type === EV.runFinished && (e.data as { status?: unknown }).status !== "done") end.failed = true;
  if (e.type === EV.messageCompleted) end.last = String((e.data as { text?: unknown }).text ?? "");
  const id = e.type === EV.runStarted ? (e.data as { sessionId?: unknown }).sessionId : undefined;
  if (typeof id === "string" && id) end.nativeId = id;
}

/** A turn's reply, and whether it's ion's own line (no agent, too long, stopped, a dream skipped). */
export type Said = { reply: string; ionLine?: IonLine };

/** ion's line for a turn that found no agent. */
export const NONE = { reply: NO_AGENT, ionLine: "no-agent" as const };

type SessionDeps = Parameters<typeof forgetSession>[0];

/** A turn's reply from how its session ended; its session kept for the next turn, or forgotten when broken. */
export function settle(d: SessionDeps, ionId: string, kept: Omit<Kept, "nativeId">, end: Ended): Said {
  const keep = () => end.nativeId && keepSession(d, ionId, { ...kept, nativeId: end.nativeId });
  // You stopped it: its session kept if it closed (resuming it is fine), else forgotten.
  if (end.stopped) {
    if (end.stuck) forgetSession(d, ionId);
    else keep();
    return { reply: STOPPED, ionLine: "stopped" };
  }
  const last = end.last.trim();
  let said: Said = { reply: last };
  if (end.late) said = { reply: TOO_LONG, ionLine: "late" };
  else if (!last) said = NONE;
  // A session that failed or said nothing is forgotten: resuming it would likely fail again (its context too long).
  // One that didn't close is too: the agent may still hold it, and two sessions would resume one id.
  const broken = end.stuck || (!end.late && (end.failed || !last));
  if (broken) forgetSession(d, ionId);
  else keep();
  return said;
}
