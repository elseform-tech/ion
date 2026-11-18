import { resolve } from "node:path";
import type { Command } from "commander";
import { ApiCallError, type IonClient } from "@ion/client";
import { connect } from "../connect.js";
import { fail, type Out, print, table } from "../output.js";

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

export function projectCommands(program: Command, out: () => Out) {
  const p = program.command("projects").description("Your projects");
  p.command("ls", { isDefault: true })
    .description("List your projects")
    .action(() =>
      call(async (c) => {
        const list = await c.call("projects.list", {});
        print(out(), list.length ? table(list.map((x) => [x.id, x.path])) : "No projects", list);
      }),
    );
  p.command("add <path>")
    .description("Add a git repo")
    .action((path: string) =>
      call(async (c) => {
        // Resolve here: the daemon's working folder isn't yours.
        const added = await c.call("projects.add", { path: path.startsWith("/") ? path : resolve(path) });
        print(out(), `Added ${added.id}`, added);
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
  p.command("access <id> <mode>")
    .description("Auto (ion decides) or full")
    .action((id: string, mode: string) => {
      if (mode !== "auto" && mode !== "full") fail("Pick auto or full");
      return call(async (c) => {
        await c.call("project.setAccess", { projectId: id, access: mode });
        print(out(), `Access for ${id}: ${mode === "full" ? "Full access" : "Auto"}`, { ok: true });
      });
    });
}
