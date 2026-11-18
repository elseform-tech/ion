import type { Command } from "commander";
import { withClient } from "../connect.js";
import { fail, type Out, print } from "../output.js";
import { clean, detailLines } from "../sanitize.js";

const WHERE = ["project", "everywhere"];

export function needsCommands(program: Command, out: () => Out) {
  program
    .command("needs")
    .description("What's waiting on you")
    .action(async () => {
      const list = await withClient((c) => c.call("needs.list", {}));
      const rows = list.map((x) => {
        const choices = (x.choices ?? []).map(
          (ch, i) => `\n  ${i + 1}. ${clean(ch.label)} — ${clean(ch.consequence)}`,
        );
        return (
          [x.needId, x.projectId ?? "-", x.summary].map(clean).join("  ") +
          `\n${detailLines(x.detail)}`.trimEnd() +
          choices.join("")
        );
      });
      print(out(), rows.length ? rows.join("\n") : "Nothing needs you", list);
    });
  program
    .command("answer <id> <choice>")
    .description("Answer a question by its number")
    .option("--always <where>", "Keep the answer for this project or everywhere")
    .action(async (id: string, choice: string, o: { always?: string }) => {
      if (o.always && !WHERE.includes(o.always)) fail("Pick project or everywhere");
      const scope = (o.always ?? "chat") as "chat" | "project" | "everywhere";
      await withClient((c) => c.call("need.answer", { needId: id, choice: Number(choice), scope }));
      print(out(), "Answered", { ok: true });
    });
}
