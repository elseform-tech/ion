import type { UserConfig } from "@ion/config";
import { EV } from "@ion/schema";
import type { MemoryFiles } from "../memory/index.js";
import { chiefTodos, markReminded, sharedIds, wasReminded } from "../memory/todos.js";
import { dueTodayLine } from "../notify/briefing.js";
import { dayOf, onDay } from "../notify/clock.js";
import type { EventStore } from "../store/index.js";

/** When to-dos are reminded without a briefing. */
export const REMIND_AT = "09:00";

/**
 * A to-do due today gets one reminder that morning, in ion chief's thread: at the briefing's time (the briefing names
 * it, and that's its reminder) or at 9:00 without one. Each is recorded, so it never comes twice, across restarts
 * too. One written after that time today isn't reminded (you just told ion about it); a done or forgotten one never.
 * "waiting" until its time; "done" once today's are settled.
 */
export function remindIfDue(
  d: { store: EventStore; memory: MemoryFiles },
  c: UserConfig,
  now: Date,
): "waiting" | "done" {
  const b = c.notifications.briefing;
  const from = onDay(now, b.on ? b.at : REMIND_AT);
  if (now < from) return "waiting";
  const today = dayOf(now);
  const before = from.toISOString();
  const due = chiefTodos(d.memory, sharedIds(c)).filter(
    (t) => t.due === today && t.updatedAt < before && !wasReminded(d.store, t.path, today),
  );
  if (!due.length) return "done";
  // Recorded first: a crash between the two loses a reminder rather than saying it twice.
  markReminded(d.store, due);
  const text = dueTodayLine(due);
  d.store.append({ chatId: "ion:chief", runId: null, origin: "daemon", type: EV.ionSaid, data: { text } });
  return "done";
}
