import type { Command } from "commander";
import { ionPaths } from "@ion/config";
import { reach } from "../daemon-control.js";
import { fail, NOT_RUNNING, type Out, print } from "../output.js";

export function statusCommand(program: Command, out: () => Out) {
  program
    .command("status")
    .description("Is ion running, and how many projects")
    .action(async () => {
      const up = await reach(ionPaths().dataDir);
      if (!up) fail(NOT_RUNNING, 2);
      const s = await up.client.call("status", {});
      up.client.close();
      const n = `${s.projects} project${s.projects === 1 ? "" : "s"}`;
      const lines = [`ion is running · ${n}`];
      if (s.configError) lines.push(s.configError);
      print(out(), lines.join("\n"), s);
    });
}
