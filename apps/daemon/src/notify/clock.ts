/** Local times of day ("HH:MM") for quiet hours and the briefing. */

/** `clock` on `day`'s date, local; `days` later (or earlier). */
export function onDay(day: Date, clock: string, days = 0): Date {
  const [h, m] = clock.split(":").map(Number) as [number, number];
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + days, h, m);
}

/** The next time the clock reads `clock`, strictly after `now`. */
export function nextAt(clock: string, now: Date): Date {
  const today = onDay(now, clock);
  return today > now ? today : onDay(now, clock, 1);
}

/** The local day, "YYYY-MM-DD". */
export function dayOf(t: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

export type Quiet = { on: boolean; from: string; to: string };
export type Window = { start: Date; end: Date };

/** The quiet window that ends at `end`: the same day's `from` (13:00–14:00), else the day before's (22:00–08:00). */
function windowEnding(q: Quiet, end: Date): Window {
  const start = onDay(end, q.from);
  return { start: start < end ? start : onDay(end, q.from, -1), end };
}

/** The quiet window `now` is in (from inclusive, to exclusive), or null; none while off or when from = to. */
export function quietNow(q: Quiet, now: Date): Window | null {
  if (!q.on || q.from === q.to) return null;
  const w = windowEnding(q, nextAt(q.to, now));
  return w.start <= now ? w : null;
}

/** The last quiet window that has ended by `now` (null while off); at most a day back. */
export function lastQuiet(q: Quiet, now: Date): Window | null {
  if (!q.on || q.from === q.to) return null;
  const today = onDay(now, q.to);
  return windowEnding(q, today <= now ? today : onDay(now, q.to, -1));
}

/** The night's hours when quiet hours are off. */
const NIGHT: Quiet = { on: true, from: "01:00", to: "06:00" };
/** A quiet night: its hours this old, and nothing in ion for this long. */
const SETTLED_MS = 60 * 60_000;
const IDLE_MS = 30 * 60_000;

/** The hours ion's own nightly work may run in: quiet hours, else 01:00–06:00. */
export const nightHours = (q: Quiet): Quiet => (q.on && q.from !== q.to ? q : NIGHT);

/**
 * A quiet night for ion's own nightly work (the agents' check, a free agent's judge check: one rule for both, Plan 21
 * final review): in its hours (nightHours) for an hour at least, with nothing in ion for 30 minutes. Its window, or
 * null.
 */
export function quietNight(q: Quiet, now: Date, lastEventAt: Date | null): Window | null {
  const w = quietNow(nightHours(q), now);
  const t = now.getTime();
  if (!w || t - w.start.getTime() < SETTLED_MS) return null;
  return t - (lastEventAt?.getTime() ?? 0) < IDLE_MS ? null : w;
}
