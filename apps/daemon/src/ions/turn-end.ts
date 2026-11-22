import type { AdapterEvent, Session } from "@ion/adapter-kit";
import { EV } from "@ion/schema";
import { cleanWhy } from "./fallback.js";

/**
 * How a turn's session ended: its last message, its native id, whether it ran past its limit, and `stuck`: it
 * didn't close in time (the agent may still hold it open).
 */
export type Ended = {
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
