import type { IonClient } from "@ion/client";
import { type EffortLevel, timeLabel, type UpcomingRun, whenLabel } from "@ion/schema";
import type { Command } from "commander";
import { withClient } from "../connect.js";
import { fail, type Out, print, table } from "../output.js";
import { clean } from "../sanitize.js";

/** When it runs next, or why it won't. */
const nextOf = (u: UpcomingRun, paused: boolean) => {
  if (paused) return "paused";
  if (!u.on) return "off";
  return u.next ? timeLabel(new Date(u.next), new Date()) : "";
};

/** The routine with this id: in the project you named, else the only one with it. */
async function find(c: IonClient, routineId: string, project?: string): Promise<UpcomingRun> {
  const hits = (await c.call("activity.list", {})).upcoming.filter(
    (u) => u.routineId === routineId && (!project || u.projectId === project),
  );
  if (hits.length > 1) fail("More than one has that id. Add -p <project>");
  return hits[0] ?? fail(`Unknown routine: ${routineId}`);
}

type AddOpts = { project: string; when: string; do: string; effort?: string };

function routineEdits(r: Command, out: () => Out) {
  r.command("remove <id>")
    .description("Remove a routine")
    .option("-p, --project <id>", "Project")
    .action(async (id: string, o: { project?: string }) => {
      await withClient(async (c) =>
        c.call("routine.remove", { projectId: (await find(c, id, o.project)).projectId, routineId: id }),
      );
      print(out(), `Removed ${clean(id)}`, { ok: true });
    });
  r.command("run <id>")
    .description("Run it now")
    .option("-p, --project <id>", "Project")
    .action(async (id: string, o: { project?: string }) => {
      const { name, started } = await withClient(async (c) => {
        const u = await find(c, id, o.project);
        return {
          name: u.name,
          started: await c.call("routine.run", { projectId: u.projectId, routineId: id }),
        };
      });
      print(out(), `Started ${clean(name)}`, started);
    });
}

export function routinesCommands(program: Command, out: () => Out) {
  const r = program.command("routines").description("What your projects' ions do on a schedule");
  r.command("ls", { isDefault: true })
    .description("List them and when each runs next")
    .action(async () => {
      const a = await withClient((c) => c.call("activity.list", {}));
      const rows = a.upcoming.map((u) =>
        [u.routineId, u.projectId, whenLabel(u.when), nextOf(u, a.paused)].map(clean),
      );
      print(out(), rows.length ? table(rows) : "No routines", a.upcoming);
    });
  r.command("add <name>")
    .description("Give a project's ion a routine")
    .requiredOption("-p, --project <id>", "Project")
    .requiredOption("-w, --when <when>", "daily 9:00, weekdays 9:00, mon 9:00 or every 4h")
    .requiredOption("-d, --do <text>", "What to do")
    .option("--effort <level>", "low, medium, high or max")
    .action(async (name: string, o: AddOpts) => {
      const args = { projectId: o.project, name, when: o.when, text: o.do };
      const added = await withClient((c) =>
        c.call("routine.add", o.effort ? { ...args, effort: o.effort as EffortLevel } : args),
      );
      print(out(), `Added ${clean(added.id)} to ${clean(o.project)}: ${whenLabel(added.when)}`, added);
    });
  routineEdits(r, out);
}
