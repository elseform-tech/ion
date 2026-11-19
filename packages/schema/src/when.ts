/**
 * When a routine runs, in the machine's local time. Four forms:
 *   "daily HH:MM", "weekdays HH:MM" (Monday to Friday), "<mon|tue|…|sun> HH:MM", "every Nh" (N 1–23: on the
 *   hours counted from midnight, so "every 4h" is 0:00, 4:00, 8:00…).
 */
export type When =
  | { kind: "daily" | "weekdays"; hour: number; minute: number }
  | { kind: "weekly"; day: number; hour: number; minute: number }
  | { kind: "hours"; every: number };

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const DAY_NAMES = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

const AT = /^(daily|weekdays|sun|mon|tue|wed|thu|fri|sat) ([01]?\d|2[0-3]):([0-5]\d)$/;
const EVERY = /^every ([1-9]|1\d|2[0-3])h$/;

/** The schedule, or null when the text isn't one. */
export function parseWhen(text: string): When | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  const e = EVERY.exec(t);
  if (e) return { kind: "hours", every: Number(e[1]) };
  const m = AT.exec(t);
  if (!m) return null;
  const hour = Number(m[2]);
  const minute = Number(m[3]);
  if (m[1] === "daily" || m[1] === "weekdays") return { kind: m[1], hour, minute };
  return { kind: "weekly", day: WEEKDAYS.indexOf(m[1] as (typeof WEEKDAYS)[number]), hour, minute };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The one way a schedule is written: "daily 09:00", "fri 14:00", "every 4h". */
export function whenText(w: When): string {
  if (w.kind === "hours") return `every ${w.every}h`;
  const at = `${pad(w.hour)}:${pad(w.minute)}`;
  return `${w.kind === "weekly" ? WEEKDAYS[w.day] : w.kind} ${at}`;
}

/** A schedule as people say it: "Every day 9:00", "Fridays 14:00", "Every 4 hours". */
export function whenLabel(text: string): string {
  const w = parseWhen(text);
  if (!w) return text;
  if (w.kind === "hours") return w.every === 1 ? "Every hour" : `Every ${w.every} hours`;
  const at = `${w.hour}:${pad(w.minute)}`;
  if (w.kind === "weekly") return `${DAY_NAMES[w.day]} ${at}`;
  return `${w.kind === "daily" ? "Every day" : "Weekdays"} ${at}`;
}

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;

/** A time near `now`, local: "9:00" today, "Tomorrow 9:00", "Yesterday 9:00", "Mon 9:00" this week, else "Nov 30 9:00". */
export function timeLabel(t: Date, now: Date): string {
  const clock = `${t.getHours()}:${pad(t.getMinutes())}`;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(t) - day(now)) / DAY_MS);
  if (days === 0) return clock;
  if (days === 1) return `Tomorrow ${clock}`;
  if (days === -1) return `Yesterday ${clock}`;
  if (days > 1 && days < 7) return `${SHORT_DAYS[t.getDay()]} ${clock}`;
  return `${MONTHS[t.getMonth()]} ${t.getDate()} ${clock}`;
}

/** The slots a schedule has on one day (local time), earliest first. */
function slotsOn(w: When, day: Date): Date[] {
  const y = day.getFullYear();
  const mo = day.getMonth();
  const d = day.getDate();
  if (w.kind === "hours") {
    const out: Date[] = [];
    for (let h = 0; h < 24; h += w.every) out.push(new Date(y, mo, d, h, 0));
    return out;
  }
  const dow = day.getDay();
  if (w.kind === "weekdays" && (dow === 0 || dow === 6)) return [];
  if (w.kind === "weekly" && dow !== w.day) return [];
  return [new Date(y, mo, d, w.hour, w.minute)];
}

/** The first time the schedule runs strictly after `from`. Throws when `when` isn't a schedule. */
export function nextRun(when: string, from: Date): Date {
  const w = parseWhen(when);
  if (!w) throw new Error(`Not a schedule: ${when}`);
  // Every form has a slot within 8 days.
  for (let i = 0; i <= 8; i++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
    const slot = slotsOn(w, day).find((s) => s.getTime() > from.getTime());
    if (slot) return slot;
  }
  throw new Error(`No time ahead for: ${when}`);
}
