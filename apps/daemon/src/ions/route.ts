import type { ChatInfo, NeedInfo } from "@ion/schema";

/**
 * What an ion reads of each project (its `projects` tool), from the daemon's views: per project, what needs you,
 * what runs and what failed.
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
    const waiting = `${asks} question${asks === 1 ? "" : "s"} waiting`;
    return `${p}: ${waiting}; running ${JSON.stringify(running)}; last run failed ${JSON.stringify(failed)}`;
  });
  return lines.join("\n");
}
