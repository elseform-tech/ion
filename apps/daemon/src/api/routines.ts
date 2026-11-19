import { addRoutine, loadUserConfig, removeRoutine, type RoutinePatch, updateRoutine } from "@ion/config";
import { type EffortLevel, nextRun, type RoutinePatch as PatchArgs } from "@ion/schema";
import { activityOf } from "../scheduler/activity.js";
import type { Handlers } from "./commands.js";
import { UserError } from "./errors.js";
import { changeConfig } from "./settings.js";

const EFFORTS: readonly string[] = ["low", "medium", "high", "max"];

function checkEffort(e: unknown): EffortLevel | undefined {
  if (e === undefined || e === null) return undefined;
  if (!EFFORTS.includes(String(e))) throw new UserError("Pick low, medium, high or max");
  return e as EffortLevel;
}

/** Your patch as config fields: skip becomes the time of the next run (the one skipped), or none. */
function fieldsOf(a: PatchArgs, configFile: string): RoutinePatch {
  const { projectId, routineId, skip, ...rest } = a;
  checkEffort(rest.effort);
  const fields: RoutinePatch = { ...rest };
  if (skip === false) fields.skip = null;
  if (skip === true) {
    const r = loadUserConfig(configFile)
      .config.projects.find((p) => p.id === projectId)
      ?.routines?.find((x) => x.id === routineId);
    if (!r) throw new UserError(`Unknown routine: ${routineId}`);
    fields.skip = nextRun(r.when, new Date()).toISOString();
  }
  return fields;
}

/** Routines (kept in your config, per project) and Activity. */
export const routineHandlers: Pick<
  Handlers,
  "routine.add" | "routine.update" | "routine.remove" | "routine.run" | "routines.pause" | "activity.list"
> = {
  "routine.add": (a, ctx) => {
    const projectId = String(a.projectId ?? "");
    const effort = checkEffort(a.effort);
    const input = { name: String(a.name ?? ""), when: String(a.when ?? ""), text: String(a.text ?? "") };
    let added: ReturnType<typeof addRoutine>["routine"] | undefined;
    changeConfig(ctx.configFile, (c) => {
      const r = addRoutine(c, projectId, effort ? { ...input, effort } : input);
      added = r.routine;
      return r.config;
    });
    // It waits for its first time from now on.
    ctx.routines.hold(projectId, added!.id);
    return added!;
  },
  "routine.update": (a, ctx) => {
    const fields = fieldsOf(a, ctx.configFile);
    changeConfig(ctx.configFile, (c) => updateRoutine(c, a.projectId, a.routineId, fields));
    // Turned on, or given a new time: no catching up on the slots before now.
    if (a.on !== undefined || a.when !== undefined) ctx.routines.hold(a.projectId, a.routineId);
    return { ok: true as const };
  },
  "routine.remove": (a, ctx) => {
    changeConfig(ctx.configFile, (c) =>
      removeRoutine(c, String(a.projectId ?? ""), String(a.routineId ?? "")),
    );
    return { ok: true as const };
  },
  "routine.run": (a, ctx) => ctx.routines.run(String(a.projectId ?? ""), String(a.routineId ?? "")),
  "routines.pause": (a, ctx) => {
    const paused = a.paused === true;
    changeConfig(ctx.configFile, (c) => ({ ...c, routines: { ...c.routines, paused } }));
    // Resumed: each routine waits for its next time.
    if (!paused) ctx.routines.hold();
    return { ok: true as const };
  },
  "activity.list": (_a, ctx) => activityOf(ctx, new Date()),
};
