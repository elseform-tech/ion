import { DEFAULT_PROJECT, type ProjectEntry, type UserConfig } from "@ion/config";
import { EV, nextRun, stripControl, timeLabel } from "@ion/schema";
import type { MemoryFiles } from "../memory/index.js";
import { chiefTodos, dayLabel, sharedIds } from "../memory/todos.js";
import type { Db, EventStore } from "../store/index.js";
import type { MemoryRow } from "../views/memory.js";
import { chatsView } from "../views/chats.js";
import { needsView } from "../views/needs.js";
import { dayOf, onDay } from "./clock.js";

const DAY_MS = 86_400_000;
/** A line in a notification or the briefing at most this long. */
const LINE_MAX = 140;
/** How many titles (or questions) the briefing names before "N more". */
const NAMED = 3;
const CHIEF = "ion:chief";

/** Plain text on one line, cut to LINE_MAX. */
export function line(s: string): string {
  const t = stripControl(s).replace(/\s+/g, " ").trim();
  return t.length > LINE_MAX ? `${t.slice(0, LINE_MAX - 1).trimEnd()}…` : t;
}

const quoted = (s: string) => `“${line(s)}”`;

/** "a", "a and b", "a, b and c"; past NAMED, "a, b, c and 2 more". */
function listed(items: string[]): string {
  const named = items.slice(0, NAMED);
  if (items.length > NAMED) named.push(`${items.length - NAMED} more`);
  return named.length < 2 ? named.join("") : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
}

/** Ends with a full stop, unless a quoted question (or sentence) already ends it. */
const sentence = (s: string) => (/[.?!…]”$/.test(s) ? s : `${s}.`);

/** Projects ion chief may read (shareWithIon = false keeps a project out of its chat, the briefing too). */
function shared(c: UserConfig): Map<string, ProjectEntry> {
  return new Map(c.projects.filter((p) => p.shareWithIon !== false).map((p) => [p.id, p]));
}

/** " in <name>" for a project, nothing for your chats outside one. */
function inProject(projects: Map<string, ProjectEntry>, projectId: string | null): string {
  const p = projectId && projectId !== DEFAULT_PROJECT ? projects.get(projectId) : undefined;
  return p ? ` in ${line(p.name ?? p.id)}` : "";
}

/** A project ion chief may read, or no project. */
const readable = (projects: Map<string, ProjectEntry>, projectId: string | null) =>
  !projectId || projectId === DEFAULT_PROJECT || projects.has(projectId);

/** Your chats (and ion's threads) that finished since `since`, by project: "Finished in Storefront: “A” and “B”." */
function finished(
  d: { store: EventStore; db: Db },
  projects: Map<string, ProjectEntry>,
  since: string,
): string[] {
  const chats = new Map(chatsView.list(d.db).map((c) => [c.chatId, c]));
  const byProject = new Map<string, Set<string>>();
  for (const e of d.store.read({ since, types: [EV.runFinished] })) {
    const chat = e.chatId ? chats.get(e.chatId) : undefined;
    if (!chat || (e.data as { status: string }).status !== "done") continue;
    if (!readable(projects, chat.projectId)) continue;
    const where = inProject(projects, chat.projectId);
    byProject.set(where, (byProject.get(where) ?? new Set()).add(quoted(chat.title)));
  }
  return [...byProject].map(([where, titles]) => sentence(`Finished${where}: ${listed([...titles])}`));
}

/** What needs you now: "2 things need you: “A” and “B”." */
function needing(db: Db, projects: Map<string, ProjectEntry>): string[] {
  const open = needsView.open(db).filter((n) => readable(projects, n.projectId));
  if (open.length === 0) return [];
  const count = open.length === 1 ? "1 thing needs you" : `${open.length} things need you`;
  return [sentence(`${count}: ${listed(open.map((n) => quoted(n.summary)))}`)];
}

/** Routines still to run today, in time order: "Today: Morning check at 9:00 in Storefront." */
function routinesToday(c: UserConfig, projects: Map<string, ProjectEntry>, now: Date): string[] {
  if (c.routines?.paused) return [];
  const today = dayOf(now);
  const slots = [...projects.values()].flatMap((p) =>
    (p.routines ?? [])
      .filter((r) => r.on)
      .map((r) => ({ r, at: nextRun(r.when, now), where: inProject(projects, p.id) }))
      .filter(({ r, at }) => dayOf(at) === today && r.skip !== at.toISOString()),
  );
  if (slots.length === 0) return [];
  slots.sort((a, b) => a.at.getTime() - b.at.getTime());
  const named = slots.map(({ r, at, where }) => `${line(r.name)} at ${timeLabel(at, now)}${where}`);
  return [sentence(`Today: ${listed(named)}`)];
}

/** "Due today: “A” and “B”." */
export const dueTodayLine = (todos: MemoryRow[]) =>
  sentence(`Due today: ${listed(todos.map((t) => quoted(t.name)))}`);

/** A to-do with its day: "“Rotate the keys” (Tue 17 Nov)". */
const withDay = (t: MemoryRow) => (t.due ? `${quoted(t.name)} (${dayLabel(t.due)})` : quoted(t.name));
const soonest = (a: MemoryRow, b: MemoryRow) => (a.due ?? "9").localeCompare(b.due ?? "9");

/** Open to-dos, due today and overdue first, then the rest (those with a day first, soonest first). */
function todoLines(todos: MemoryRow[], today: string): string[] {
  const dueToday = todos.filter((t) => t.due === today);
  const overdue = todos.filter((t) => t.due && t.due < today).sort(soonest);
  const rest = todos.filter((t) => !t.due || t.due > today).sort(soonest);
  return [
    ...(dueToday.length ? [dueTodayLine(dueToday)] : []),
    ...(overdue.length ? [sentence(`Overdue: ${listed(overdue.map(withDay))}`)] : []),
    ...(rest.length ? [sentence(`Still to do: ${listed(rest.map(withDay))}`)] : []),
  ];
}

type BriefingDeps = { store: EventStore; db: Db; memory?: MemoryFiles };

/** The briefing's words: plain sentences, no headings; "" when there's nothing to say. To-dos lead. */
function briefingText(d: BriefingDeps, c: UserConfig, since: string, now: Date): string {
  const projects = shared(c);
  const todos = d.memory ? todoLines(chiefTodos(d.memory, sharedIds(c)), dayOf(now)) : [];
  return [
    ...todos,
    ...finished(d, projects, since),
    ...needing(d.db, projects),
    ...routinesToday(c, projects, now),
  ].join("\n");
}

/**
 * ion chief's daily briefing, once its time came today: "posted" (now, or earlier today: `briefing.posted` keeps
 * that across a restart), "nothing" to say today, or "waiting" (not yet its time, or it's off). It names your open
 * to-dos (due today and overdue first), what finished since the last briefing (a day back at most), what needs you,
 * and today's routines.
 */
export function briefIfDue(d: BriefingDeps, c: UserConfig, now: Date): "posted" | "nothing" | "waiting" {
  const b = c.notifications.briefing;
  if (!b.on || now < onDay(now, b.at)) return "waiting";
  const day = dayOf(now);
  const posts = d.store.read({ types: [EV.briefingPosted] });
  if (posts.some((e) => (e.data as { day: string }).day === day)) return "posted";
  // A day back at most: after a week away, the first briefing doesn't name the whole week.
  const dayBack = new Date(now.getTime() - DAY_MS).toISOString();
  const last = posts.at(-1)?.ts;
  const since = last && last > dayBack ? last : dayBack;
  const text = briefingText(d, c, since, now);
  if (!text) return "nothing";
  // Recorded first: a crash between the two loses a briefing rather than posting it twice.
  d.store.append({ chatId: null, runId: null, origin: "daemon", type: EV.briefingPosted, data: { day } });
  d.store.append({ chatId: CHIEF, runId: null, origin: "daemon", type: EV.ionSaid, data: { text } });
  return "posted";
}
