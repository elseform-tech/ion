import type { Command } from "commander";
import { withClient } from "../connect.js";
import { type Out, print } from "../output.js";
import { clean } from "../sanitize.js";

export function decisionsCommands(program: Command, out: () => Out) {
  const d = program.command("decisions").description("Your answers, and what came of them");
  d.command("ls", { isDefault: true })
    .description("List them")
    .option("-p, --project <id>", "Project")
    .action(async (o: { project?: string }) => {
      const list = await withClient((c) =>
        c.call("decisions.list", o.project ? { projectId: o.project } : {}),
      );
      const rows = list.map(
        (x) =>
          [x.decisionId, x.scope === "project" ? x.projectId : x.scope, `${x.question} → ${x.choice}`]
            .map(clean)
            .join("  ") + x.outcomes.map((o) => `\n  ${o.kind}: ${clean(o.text)}`).join(""),
      );
      print(out(), rows.length ? rows.join("\n") : "No decisions", list);
    });
  d.command("note <id> <text>")
    .description("Add what happened")
    .action(async (id: string, text: string) => {
      await withClient((c) => c.call("decision.note", { decisionId: id, text }));
      print(out(), "Noted", { ok: true });
    });
  d.command("forget <id>")
    .description("Forget it")
    .action(async (id: string) => {
      await withClient((c) => c.call("decision.forget", { decisionId: id }));
      print(out(), "Forgotten", { ok: true });
    });
}
