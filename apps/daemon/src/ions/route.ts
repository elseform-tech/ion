import type { ChatInfo, NeedInfo } from "@ion/schema";

/** The finished chats a project's line names, newest first. */
const FINISHED = 3;

/**
 * What an ion reads of each project (its `projects` tool), from the daemon's views: per project, what needs you,
 * what runs, what failed and what finished.
 */
export function contextOf(projects: string[], chats: ChatInfo[], needs: NeedInfo[]): string {
  const lines = projects.map((p) => {
    const mine = chats.filter((c) => c.projectId === p && !c.archived);
    // How many questions wait, never their text: an agent wrote it, and it must not steer ion chief.
    const asks = needs.filter((n) => n.projectId === p).length;
    const running = mine
      .filter((c) => ["queued", "running"].includes(c.lastRunStatus ?? ""))
      .map((c) => c.title);
    const failed = mine.filter((c) => c.lastRunStatus === "failed").map((c) => c.title);
    // What finished well, newest first (Plan 23's evals: ion chief had nothing to name it by, so it left it out).
    const finished = mine
      .filter((c) => c.lastRunStatus === "done")
      .sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""))
      .slice(0, FINISHED)
      .map((c) => c.title);
    const waiting = `${asks} question${asks === 1 ? "" : "s"} waiting`;
    const now = `${waiting}; running ${JSON.stringify(running)}; last run failed ${JSON.stringify(failed)}`;
    return `${p}: ${now}; finished ${JSON.stringify(finished)}`;
  });
  return lines.join("\n");
}
