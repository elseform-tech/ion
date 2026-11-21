import { HOOK_EVENTS, type HookEvent } from "@ion/schema";
import type { Command } from "commander";
import { withClient } from "../connect.js";
import { fail, type Out, print } from "../output.js";
import { addedLine, toolVerbs } from "./tool-verbs.js";

type AddOpts = { on: string; run: string; name?: string; from?: string };

/** `ion hooks …`: commands that run on ion's events. One added starts off. */
export function hooksCommands(program: Command, out: () => Out) {
  const h = program.command("hooks").description("Hooks");
  h.command("add")
    .description("Add one, off")
    .requiredOption("--on <event>", `When it runs: ${HOOK_EVENTS.join(", ")}`)
    .requiredOption("--run <command>", "What it runs")
    .option("--name <name>", "Its name")
    .option("--from <link>", "Where it came from")
    .action(async (o: AddOpts) => {
      if (!HOOK_EVENTS.includes(o.on as HookEvent)) fail(`Pick one of: ${HOOK_EVENTS.join(", ")}`);
      const item = await withClient((c) =>
        c.call("tools.add", {
          ...{ kind: "hook", event: o.on as HookEvent, run: o.run },
          ...(o.name ? { name: o.name } : {}),
          ...(o.from ? { from: o.from } : {}),
        }),
      );
      print(out(), addedLine(item), item);
    });
  toolVerbs(h, "hook", out);
}
