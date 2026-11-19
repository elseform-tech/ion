import type { Command } from "commander";
import { withClient } from "../connect.js";
import { fail, type Out, print } from "../output.js";
import { needText } from "../render.js";

const WHERE = ["project", "everywhere"];

export function needsCommands(program: Command, out: () => Out) {
  program
    .command("needs")
    .description("What's waiting on you")
    .action(async () => {
      const list = await withClient((c) => c.call("needs.list", {}));
      const rows = list.map(needText);
      print(out(), rows.length ? rows.join("\n") : "Nothing needs you", list);
    });
  program
    .command("answer <id> <answer...>")
    .description("Answer a question: a choice's number, or your own words")
    .option("--always <where>", "Keep the answer for this project or everywhere")
    .action(async (id: string, words: string[], o: { always?: string }) => {
      if (o.always && !WHERE.includes(o.always)) fail("Pick project or everywhere");
      const scope = (o.always ?? "chat") as "chat" | "project" | "everywhere";
      const answer = words.join(" ");
      const pick = /^\d+$/.test(answer) ? { choice: Number(answer) } : { text: answer };
      await withClient((c) => c.call("need.answer", { needId: id, ...pick, scope }));
      print(out(), "Answered", { ok: true });
    });
}
