import { EV } from "@ion/schema";
import type { EventStore } from "../store/index.js";

/**
 * Whether a run ended on its agent's limit (its error says so). ion asks, waits or continues the chat then: it isn't
 * a failure to tell you about, report, or suggest picking up (final review, 2026-11-23).
 */
export const endedOnLimit = (store: Pick<EventStore, "read">, runId: string | null): boolean =>
  !!runId && store.read({ runId, types: [EV.error] }).some((e) => !!(e.data as { limit?: unknown }).limit);
