import { DEFAULT_PROJECT, loadUserConfig, type ProjectEntry } from "@ion/config";
import type { ActivityInfo, RecentRun, UpcomingRun } from "@ion/schema";
import type { Db } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { routinesView } from "../views/routines.js";
import { runsView } from "../views/runs.js";
import type { Routines } from "./routines.js";

type Deps = { db: Db; configFile: string; routines: Pick<Routines, "next" | "paused"> };

const ionName = (p: ProjectEntry) => p.name ?? p.id;

/** Every routine's next run, soonest first; the paused ones after, in your config's order. */
function upcoming(d: Deps, projects: ProjectEntry[], now: Date): UpcomingRun[] {
  const rows = projects.flatMap((p) =>
    (p.routines ?? []).map((r): UpcomingRun => {
      const next = d.routines.next(r);
      return {
        projectId: p.id,
        routineId: r.id,
        name: r.name,
        when: r.when,
        ion: ionName(p),
        next: next?.toISOString() ?? null,
        effort: r.effort ?? p.effort ?? null,
        on: r.on,
        // A skip still ahead (one in the past was spent).
        skipped: next !== null && r.skip !== undefined && Date.parse(r.skip) > now.getTime(),
      };
    }),
  );
  const t = (u: UpcomingRun) => (u.next ? Date.parse(u.next) : Number.POSITIVE_INFINITY);
  return rows.sort((a, b) => t(a) - t(b));
}

/** Ion threads' runs since `since`, newest first, each with its title, ion and the routine that started it. */
function recent(d: Deps, projects: ProjectEntry[], since: Date): RecentRun[] {
  const threads = chatsView.list(d.db).filter((c) => c.by === "ion" && c.projectId);
  const chats = new Map(threads.map((c) => [c.chatId, c]));
  const byRoutine = routinesView.threads(d.db);
  const names = new Map(projects.map((p) => [p.id, ionName(p)]));
  return runsView.since(d.db, [...chats.keys()], since.toISOString()).map((r) => {
    const chat = chats.get(r.chatId)!;
    const projectId = chat.projectId ?? "";
    return {
      runId: r.runId,
      chatId: r.chatId,
      title: chat.title,
      projectId,
      ion: names.get(projectId) ?? projectId,
      routine: byRoutine.get(r.chatId) ?? null,
      status: r.status,
      costUsd: r.cost,
      at: r.startedAt,
    };
  });
}

/** Activity, in the machine's local days: pause all, what's next, and ion threads' runs today and yesterday. */
export function activityOf(d: Deps, now: Date): ActivityInfo {
  const projects = loadUserConfig(d.configFile).config.projects.filter((p) => p.id !== DEFAULT_PROJECT);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const runs = recent(d, projects, yesterday);
  return {
    paused: d.routines.paused(),
    upcoming: upcoming(d, projects, now),
    today: runs.filter((r) => Date.parse(r.at) >= today.getTime()),
    yesterday: runs.filter((r) => Date.parse(r.at) < today.getTime()),
  };
}
