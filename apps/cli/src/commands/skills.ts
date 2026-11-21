import { resolve } from "node:path";
import type { Command } from "commander";
import { withClient } from "../connect.js";
import { type Out, print } from "../output.js";
import { addedLine, toolVerbs } from "./tool-verbs.js";

/** `ion skills …`: skills; one added is copied into ion's own folder, and starts off. */
export function skillsCommands(program: Command, out: () => Out) {
  const s = program.command("skills").description("Skills");
  s.command("add <name>")
    .description("Add one, off")
    .requiredOption("--from <link or folder>", "A link to its SKILL.md, or its folder")
    .action(async (name: string, o: { from: string }) => {
      const from = o.from.startsWith("https://") ? o.from : resolve(o.from);
      const item = await withClient((c) => c.call("tools.add", { kind: "skill", name, from }));
      print(out(), addedLine(item), item);
    });
  toolVerbs(s, "skill", out);
}
