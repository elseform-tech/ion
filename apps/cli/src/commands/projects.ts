import { resolve } from "node:path";
import type { Command } from "commander";
import { ApiCallError } from "@ion/client";
import { ionPaths } from "@ion/config";
import { reach } from "../daemon-control.js";
import { fail, NOT_RUNNING, type Out, print } from "../output.js";

async function client() {
  const up = await reach(ionPaths().dataDir);
  if (!up) fail(NOT_RUNNING, 2);
  return up.client;
}

export function projectCommands(program: Command, out: () => Out) {
  const p = program.command("projects").description("Your projects");
  p.command("ls").action(async () => {
    const c = await client();
    const list = await c.call("projects.list", {});
    c.close();
    print(out(), list.length ? list.map((x) => `${x.id}  ${x.path}`).join("\n") : "No projects", list);
  });
  p.command("add <path>").action(async (path: string) => {
    const c = await client();
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
}
