import type { ChatInfo, ProjectInfo } from "@ion/schema";

/** Three first messages for a folder you just picked (Plan 21). */
export const EXAMPLES = [
  "What does this project do?",
  "Find a small bug and fix it",
  "Add a test for the code that has none",
];

/**
 * The project a new chat goes in until you pick one (Plan 21 audit, 2026-11-23: it was always ion's empty `default`):
 * the one your latest chat is in, else your first own project, else `default`.
 */
export function lastProject(chats: ChatInfo[], projects: ProjectInfo[]): string {
  const known = new Set(projects.map((p) => p.id));
  const latest = [...chats]
    .filter((c) => !c.archived && c.by !== "ion" && known.has(c.projectId ?? ""))
    .sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""))[0];
  return latest?.projectId || (projects.find((p) => p.id !== "default")?.id ?? "default");
}
