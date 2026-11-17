import type { Command } from "commander";
import { withClient } from "../connect.js";
import { type Out, print } from "../output.js";
import { clean } from "../sanitize.js";

export function memoryCommands(program: Command, out: () => Out) {
  const m = program.command("memory").description("What ion remembers");
  m.command("ls")
    .description("List it")
    .option("-p, --project <id>", "Project")
    .action(async (o: { project?: string }) => {
      const list = await withClient((c) => c.call("memory.list", o.project ? { projectId: o.project } : {}));
      const rows = list.map((x) => [x.memoryId, x.scope, x.text].map(clean).join("  "));
      print(out(), rows.length ? rows.join("\n") : "No memory", list);
    });
  m.command("forget <id>")
    .description("Forget it")
    .action(async (id: string) => {
      await withClient((c) => c.call("memory.forget", { memoryId: id }));
      print(out(), "Forgotten", { ok: true });
    });
}
