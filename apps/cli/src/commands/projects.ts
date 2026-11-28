import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { ApiCallError, type IonClient } from "@ion/client";
import { connect } from "../connect.js";
import { fail, type Out, print, table } from "../output.js";
import { clean } from "../sanitize.js";

/** Calls the daemon; a refusal becomes its message, anything else a plain error. */
async function call(f: (c: IonClient) => Promise<void>): Promise<void> {
  const c = await connect();
  try {
    await f(c);
  } catch (e) {
    fail(e instanceof ApiCallError ? e.message : "Something went wrong");
  } finally {
    c.close();
  }
}

/** ion's git setup, in one line (Plan 21): what went in the first commit, and that some files were left out. */
function setUpLine(s: { files: number; left: number } | undefined): string {
  if (!s) return "";
  const files = `${s.files} ${s.files === 1 ? "file" : "files"}`;
  const left = s.left ? `, ${s.left} left out (secrets, dependencies, build output, big files)` : "";
  return `\nGit set up: ${files} in its first commit${left}`;
}

/** Your yes to ion's question: in the terminal when there is one, else only with --yes. */
async function yes(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(a.trim());
}

/**
 * Adds a folder, answering ion's question first (review of Plan 21 Task 2, 2026-11-23: git was set up without
 * asking): --yes, or y at the prompt; with no terminal, how to say yes.
 */
async function addAsking(c: IonClient, path: string, sure: boolean) {
  try {
    return await c.call("projects.add", { path, ...(sure ? { confirm: true } : {}) });
  } catch (e) {
    if (!(e instanceof ApiCallError) || e.code !== "confirm") throw e;
    if (!(await yes(e.message))) return fail(`${e.message}\nRun it again with --yes`);
    return c.call("projects.add", { path, confirm: true });
  }
}

export function projectCommands(program: Command, out: () => Out) {
  const p = program.command("projects").description("Your projects");
  p.command("ls", { isDefault: true })
    .description("List your projects")
    .action(() =>
      call(async (c) => {
        const list = await c.call("projects.list", {});
        // A renamed project: its id (what commands take), then the name ion shows.
        const named = list.some((x) => x.name);
        const rows = list.map((x) => (named ? [x.id, x.name ?? "", x.path] : [x.id, x.path]).map(clean));
        print(out(), list.length ? table(rows) : "No projects", list);
      }),
    );
  p.command("add <path>")
    .description("Add a folder")
    .option("--yes", "Set up git in it without asking")
    .action((path: string, o: { yes?: boolean }) =>
      call(async (c) => {
        // Resolve here: the daemon's working folder isn't yours.
        const added = await addAsking(c, path.startsWith("/") ? path : resolve(path), o.yes === true);
        print(out(), `Added ${added.id}${setUpLine(added.gitSetUp)}`, added);
      }),
    );
  p.command("new <name>")
    .description("Make a new project")
    .action((name: string) =>
      call(async (c) => {
        const made = await c.call("project.create", { name });
        print(out(), `Created ${made.id} at ${made.path}`, made);
      }),
    );
  projectEdits(p, out);
}

/** Changing a project you have: its name, taking it out of ion, its access. */
function projectEdits(p: Command, out: () => Out) {
  p.command("rename <id> <name...>")
    .description("Show a project under a new name")
    .action((id: string, name: string[]) =>
      call(async (c) => {
        await c.call("project.rename", { projectId: id, name: name.join(" ") });
        print(out(), `Renamed ${id}`, { ok: true });
      }),
    );
  // Review of Plan 21 Task 4 (2026-11-28): a project's own agent for the chats its ion starts, as in its Settings page.
  p.command("agent <id> [agent]")
    .description("What the chats its ion starts run on")
    .option("--model <model>", "Model")
    .option("--effort <level>", "low, medium, high or max")
    .option("--clear", "Back to the default")
    .action(
      (id: string, agent: string | undefined, o: { model?: string; effort?: string; clear?: boolean }) =>
        call(async (c) => {
          const effort = o.effort as "low" | "medium" | "high" | "max" | undefined;
          const patch = o.clear
            ? { harness: null, model: null, effort: null }
            : { ...(agent ? { harness: agent, model: o.model ?? null } : {}), ...(effort ? { effort } : {}) };
          if (Object.keys(patch).length) await c.call("project.update", { projectId: id, ...patch });
          const p = (await c.call("projects.list", {})).find((x) => x.id === id);
          if (!p) fail(`Unknown project: ${id}`);
          const on = [p.harness, p.model, p.effort].filter(Boolean).map((x) => clean(String(x)));
          print(out(), `${clean(id)}'s chats run on ${on.length ? on.join(" · ") : "the default"}`, p);
        }),
    );
  p.command("remove <id>")
    .description("Take a project out of ion (its folder stays)")
    .action((id: string) =>
      call(async (c) => {
        await c.call("project.remove", { projectId: id });
        print(out(), `Removed ${id}`, { ok: true });
      }),
    );
}
