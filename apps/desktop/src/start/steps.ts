import type { ChatInfo, HarnessInfo, ProjectInfo } from "@ion/schema";

/** One agent's first step: ready, else the command that installs it or signs it in (as `start.status` says). */
export type Step = { state: "ready" | "install" | "signIn"; command?: string };

export function stepOf(h: HarnessInfo): Step {
  if (h.installed && h.signedIn) return { state: "ready" };
  if (!h.installed) return { state: "install", ...(h.install ? { command: h.install } : {}) };
  return { state: "signIn", ...(h.signIn ? { command: h.signIn.command } : {}) };
}

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
