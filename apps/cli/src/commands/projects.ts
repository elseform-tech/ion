import { resolve } from "node:path";
import type { Command } from "commander";
import { ApiCallError } from "@ion/client";
import { connect } from "../connect.js";
import { fail, type Out, print } from "../output.js";

export function projectCommands(program: Command, out: () => Out) {
  const p = program.command("projects").description("Your projects");
  p.command("ls")
    .description("List your projects")
    .action(async () => {
      const c = await connect();
      const list = await c.call("projects.list", {});
      c.close();
      print(out(), list.length ? list.map((x) => `${x.id}  ${x.path}`).join("\n") : "No projects", list);
    });
  p.command("add <path>")
    .description("Add a git repo")
    .action(async (path: string) => {
      const c = await connect();
      try {
        // Resolve here: the daemon's working folder isn't yours.
        const added = await c.call("projects.add", { path: path.startsWith("/") ? path : resolve(path) });
        print(out(), `Added ${added.id}`, added);
      } catch (e) {
        fail(e instanceof ApiCallError ? e.message : "Something went wrong");
      } finally {
        c.close();
      }
    });
  p.command("access <id> <mode>")
    .description("Auto (ion decides) or full")
    .action(async (id: string, mode: string) => {
      if (mode !== "auto" && mode !== "full") fail("Pick auto or full");
      const c = await connect();
      try {
        await c.call("project.setAccess", { projectId: id, access: mode });
        print(out(), `Access for ${id}: ${mode === "full" ? "Full access" : "Auto"}`, { ok: true });
      } catch (e) {
        fail(e instanceof ApiCallError ? e.message : "Something went wrong");
      } finally {
        c.close();
      }
    });
}
