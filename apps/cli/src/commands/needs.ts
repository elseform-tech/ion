import type { Command } from "commander";
import { withClient } from "../connect.js";
import { type Out, print } from "../output.js";
import { clean } from "../sanitize.js";

export function needsCommands(program: Command, out: () => Out) {
  const n = program
    .command("needs")
    .description("What's waiting on you")
    .action(async () => {
      const list = await withClient((c) => c.call("needs.list", {}));
      const rows = list.map((x) => [x.needId, x.projectId ?? "-", x.summary].map(clean).join("  "));
      print(out(), rows.length ? rows.join("\n") : "Nothing needs you", list);
    });
  const answer = (decision: "allow" | "deny", done: string) => async (id: string) => {
    await withClient((c) => c.call("need.resolve", { needId: id, decision }));
    print(out(), done, { ok: true });
  };
  n.command("allow <id>").description("Allow it").action(answer("allow", "Allowed"));
  n.command("deny <id>").description("Deny it").action(answer("deny", "Denied"));
}
