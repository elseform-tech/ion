import type { UserConfig } from "@ion/config";
import { EV, type MemoryScope } from "@ion/schema";
import { UserError } from "../api/errors.js";
import type { EventStore } from "../store/index.js";
import type { MemoryRow } from "../views/memory.js";
import type { MemoryFiles } from "./index.js";
import { ScopedMemory } from "./scoped.js";

/**
 * To-dos are memory files (`type: todo`, `status`, an optional `due` day): the same files ion and you keep, here
 * read and changed for ion chief's briefing, its reminders, "Mark done?" and `ion todo`.
 */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ALL = Number.MAX_SAFE_INTEGER;

/** "Tue 17 Nov", as the app writes a day. */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const t = new Date(y, m - 1, d);
  return `${DAYS[t.getDay()]} ${t.getDate()} ${MONTHS[t.getMonth()]}`;
}

/** The projects ion chief may read (shareWithIon = false keeps a project's to-dos out of its thread). */
export const sharedIds = (c: UserConfig) =>
  c.projects.filter((p) => p.shareWithIon !== false).map((p) => p.id);

/** Open to-dos ion chief may see: yours and those of the projects shared with it. */
export function chiefTodos(memory: MemoryFiles, projects: string[]): MemoryRow[] {
  const m = new ScopedMemory(memory, { kind: "ion", ionId: "chief", projects });
  return m.index({ type: "todo", status: "open", limit: ALL });
}

/** This to-do was reminded for this due day (in a briefing or its own line). */
export const wasReminded = (store: EventStore, path: string, due: string) =>
  store
    .read({ types: [EV.todoReminded] })
    .some(
      (e) =>
        (e.data as { path: string; due: string }).path === path && (e.data as { due: string }).due === due,
    );

/** Records each to-do's reminder for its due day, so it never comes again. */
export function markReminded(store: EventStore, todos: MemoryRow[]): void {
  for (const t of todos)
    if (t.due)
      store.append({
        chatId: null,
        runId: null,
        origin: "daemon",
        type: EV.todoReminded,
        data: { path: t.path, due: t.due },
      });
}

/** Where a to-do goes: "you", or a project's id. */
const scopeWord = (s: MemoryScope) => (s === "you" ? "you" : s.projectId);

/** One line of a to-do's words: its name (≤ 80) and description (≤ 160). */
function namesOf(text: string): { name: string; description: string } {
  const one = text
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!one) throw new UserError("Say what to do");
  return { name: one.slice(0, 80).trimEnd(), description: one.slice(0, 160).trimEnd() };
}

/** A new to-do of yours (or a project's), by you; `due` a day. */
export function addTodo(memory: MemoryFiles, a: { text: string; projectId?: string; due?: string }) {
  const m = new ScopedMemory(memory, { kind: "you" });
  const { name, description } = namesOf(a.text);
  const text = a.text.trim();
  return m.write({
    scope: a.projectId ?? "you",
    name,
    description,
    type: "todo",
    text,
    ...(a.due ? { due: a.due } : {}),
  });
}

/** Marks a to-do done, as you (only as read: a change since is refused). */
export function closeTodo(memory: MemoryFiles, name: string) {
  const m = new ScopedMemory(memory, { kind: "you" });
  const f = m.read(name);
  if (f.header.type !== "todo") throw new UserError("That's not a to-do");
  return m.write({ scope: scopeWord(f.scope), path: f.path, status: "done", expect: f.hash });
}
