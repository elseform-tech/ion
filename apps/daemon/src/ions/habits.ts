import { whenText } from "@ion/schema";
import { titleOf } from "../runs/ready.js";

/** Something you asked for in a project: a message to its ion (text), or a chat you started (title and text). */
export type Asked = { at: Date; text: string | null; title: string | null; chatId: string | null };

/** What you keep asking for: its key, a name and text for the routine, when it would run, and the days you asked. */
export type Habit = { key: string; name: string; text: string; when: string; dates: string[] };

/** The same thing on this many different days is a habit. */
const DAYS = 3;
/** Only what you asked in the last four weeks counts. */
const LOOK_BACK_MS = 28 * 86_400_000;

const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
const DATES = [
  /\b\d{4}-\d{1,2}-\d{1,2}\b/g,
  /\b\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?\b/g,
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}(?:\\s+\\d{4})?`, "g"),
  new RegExp(`\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, "g"),
];

/** "The same thing": your words lowercased, without dates and punctuation. */
export function sameKey(s: string): string {
  let t = s.toLowerCase();
  for (const d of DATES) t = t.replace(d, " ");
  return t
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const dayOf = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const pad = (n: number) => String(n).padStart(2, "0");

/** When a routine for these times would run: their one weekday, else daily; at their median time, to the half hour. */
export function whenFor(times: Date[]): string {
  const mins = times.map((t) => t.getHours() * 60 + t.getMinutes()).sort((a, b) => a - b);
  const mid = mins.length / 2;
  const median = mins.length % 2 ? mins[Math.floor(mid)]! : (mins[mid - 1]! + mins[mid]!) / 2;
  const at = Math.min(Math.round(median / 30) * 30, 23 * 60 + 30);
  const hour = Math.floor(at / 60);
  const minute = at % 60;
  const days = new Set(times.map((t) => t.getDay()));
  if (days.size === 1) return whenText({ kind: "weekly", day: [...days][0]!, hour, minute });
  return `daily ${pad(hour)}:${pad(minute)}`;
}

/** A routine's name from your words: their first line, cut short, without closing stops, capitalised. */
function nameOf(words: string): string {
  const t = titleOf(words);
  let end = t.length;
  while (end > 0 && ".!?;:, ".includes(t[end - 1]!)) end--;
  return t.charAt(0).toUpperCase() + t.slice(1, end);
}

/** The latest of each day's asks, newest first. */
function perDay(asks: Asked[]): Asked[] {
  const latest = new Map<string, Asked>();
  for (const a of asks) {
    const k = dayOf(a.at);
    const had = latest.get(k);
    if (!had || had.at < a.at) latest.set(k, a);
  }
  return [...latest.values()].sort((a, b) => b.at.getTime() - a.at.getTime());
}

/**
 * What you asked for on at least 3 different days in the last four weeks, the same thing each time: by key, named
 * from your latest words. A key of one word ("status") is too little to go on.
 */
export function habits(asks: Asked[], now: Date): Habit[] {
  const groups = new Map<string, Asked[]>();
  for (const a of asks) {
    if (now.getTime() - a.at.getTime() > LOOK_BACK_MS) continue;
    const key = sameKey(a.title ?? a.text ?? "");
    if (key.split(" ").length < 2) continue;
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  const out: Habit[] = [];
  for (const [key, all] of groups) {
    const days = perDay(all);
    if (days.length < DAYS) continue;
    const last = days[0]!;
    const words = last.title ?? last.text ?? key;
    out.push({
      key,
      name: nameOf(words),
      text: last.text ?? words,
      when: whenFor(days.map((d) => d.at)),
      dates: days.map((d) => d.at.toISOString()),
    });
  }
  return out;
}
