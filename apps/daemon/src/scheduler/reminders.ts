import type { UserConfig } from "@ion/config";
import { EV } from "@ion/schema";
import type { MemoryFiles } from "../memory/index.js";
import { chiefTodos, markReminded, sharedIds, wasReminded } from "../memory/todos.js";
import { dueTodayLine } from "../notify/briefing.js";
import { dayOf, onDay, quietNow } from "../notify/clock.js";
import type { EventStore } from "../store/index.js";
import type { MemoryRow } from "../views/memory.js";

/** When to-dos due today are reminded (or when quiet hours end, if they cover it). */
export const REMIND_AT = "09:00";

/** When each file was last made (a write with no text before it): later edits don't count. */
function madeAt(store: EventStore): Map<string, string> {
  const made = new Map<string, string>();
  for (const e of store.read({ types: [EV.memoryWritten] }))
    if (!(e.data as { before?: unknown }).before) made.set((e.data as { path: string }).path, e.ts);
  return made;
}

/**
 * A to-do due today gets one reminder that morning, at 9:00 local (when quiet hours end, if they cover it), said in
 * ion chief's thread; the caller notifies you of it. Each is recorded, so it never comes twice, across restarts too.
 * One made after that time today isn't reminded (you just told ion about it); a done or forgotten one never.
 * "waiting" until its time; then the to-dos reminded now (none: today's are settled).
 */
export function remindIfDue(
  d: { store: EventStore; memory: MemoryFiles },
  c: UserConfig,
  now: Date,
): "waiting" | MemoryRow[] {
  const from = onDay(now, REMIND_AT);
  if (now < from || quietNow(c.notifications.quiet, now)) return "waiting";
  const today = dayOf(now);
  const before = from.toISOString();
  const todos = chiefTodos(d.memory, sharedIds(c)).filter((t) => t.due === today);
  if (!todos.length) return [];
  const made = madeAt(d.store);
  const due = todos.filter(
    (t) => (made.get(t.path) ?? t.updatedAt) < before && !wasReminded(d.store, t.path, today),
  );
  if (!due.length) return [];
  // Recorded first: a crash between the two loses a reminder rather than saying it twice.
  markReminded(d.store, due);
  const text = dueTodayLine(due);
  d.store.append({ chatId: "ion:chief", runId: null, origin: "daemon", type: EV.ionSaid, data: { text } });
  return due;
}
