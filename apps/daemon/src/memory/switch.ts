import { projectRemembered, type UserConfig, youRemembered } from "@ion/config";
import type { Caller } from "./scoped.js";

/**
 * Memory's switches as one run or one ion's turn has them (the user, 2026-11-23: "a way to disable memory"): what's
 * off gets no memory tools, no index and no word of memory in its instructions, and writes nothing.
 */

/** An ion's memory when some of it is off: whether yours is on, and the projects whose memory is. */
export type IonMemory = { you: boolean; projects: string[] };

/**
 * A chat's memory: "none" (off in its project, or a chat you said not to remember), "project" (its project's files
 * only: yours are off), or undefined (all of it).
 */
export function runMemory(
  c: UserConfig,
  projectId: string,
  notRemembered: boolean,
): "none" | "project" | undefined {
  if (notRemembered || !projectRemembered(c, projectId)) return "none";
  return youRemembered(c) ? undefined : "project";
}

/**
 * An ion's memory over the projects it may see; undefined when all of it is on. A project's ion (`own`) whose project
 * is off doesn't see yours either.
 */
export function ionMemory(c: UserConfig, projects: string[], own: boolean): IonMemory | undefined {
  const on = projects.filter((p) => projectRemembered(c, p));
  const you = youRemembered(c) && (!own || on.length > 0);
  return you && on.length === projects.length ? undefined : { you, projects: on };
}

type RunMemory = "none" | "project" | undefined;
const RANK: Record<string, number> = { none: 2, project: 1 };

/** The less of two runs' memories ("none", then "project", then all of it), as `{ memory }` (absent: all). */
export function leastMemory(a: RunMemory, b: RunMemory): { memory?: "none" | "project" } {
  const m = (RANK[a ?? ""] ?? 0) >= (RANK[b ?? ""] ?? 0) ? a : b;
  return m ? { memory: m } : {};
}

/** The less of two ions' memories: yours only if both have it, and the projects both have. */
export function leastIonMemory(a?: IonMemory, b?: IonMemory): IonMemory | undefined {
  if (!a || !b) return a ?? b;
  return { you: a.you && b.you, projects: a.projects.filter((p) => b.projects.includes(p)) };
}

/** Whether an ion has any memory at all. */
export const ionRemembers = (m: IonMemory | undefined): boolean => !m || m.you || m.projects.length > 0;

/** Who a run's memory tools and index are for; null when it has no memory. */
export function chatCaller(s: {
  projectId: string;
  chatId: string;
  runId: string;
  memory?: "none" | "project";
}): (Caller & { kind: "chat" }) | null {
  if (s.memory === "none") return null;
  const c = { kind: "chat" as const, projectId: s.projectId, chatId: s.chatId, runId: s.runId };
  return s.memory === "project" ? { ...c, you: false } : c;
}

/** Who an ion's memory tools and index are for (only the projects whose memory is on); null when it has none. */
export function ionCaller(s: {
  ionId: string;
  projects: string[];
  memory?: IonMemory;
}): (Caller & { kind: "ion" }) | null {
  const m = s.memory;
  if (!ionRemembers(m)) return null;
  const projects = m ? s.projects.filter((p) => m.projects.includes(p)) : s.projects;
  const c = { kind: "ion" as const, ionId: s.ionId, projects };
  return m && !m.you ? { ...c, you: false } : c;
}

/**
 * The projects an ion's session saw, and what of its memory was off (a mark no project's id can be), so a session
 * started with memory isn't resumed without it, or the other way round (the user, 2026-11-23).
 */
export function sessionProjects(scope: { projects: string[]; memory?: IonMemory }): string[] {
  const m = scope.memory;
  if (!m) return scope.projects;
  return [...scope.projects, `_memory:${m.you ? "you" : ""}:${m.projects.join(",")}`];
}
