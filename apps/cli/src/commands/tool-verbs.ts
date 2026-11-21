import type { ToolCheck, ToolItem, ToolType } from "@ion/schema";
import type { Command } from "commander";
import { withClient } from "../connect.js";
import { type Out, print, table } from "../output.js";
import { clean } from "../sanitize.js";

/**
 * Where it came from (its source, else "Unknown source") and the chat that added it, if one did; nothing for one
 * written into mcp.json or config by hand.
 */
const whence = (i: ToolItem): string[] => [
  i.origin ? clean(i.origin.source ?? "Unknown source") : "",
  i.origin?.by === "agent" ? clean(`by ${i.origin.chatTitle ?? "a chat"}`) : "",
];

/** "github added, off", as the chat says it. */
export const addedLine = (i: ToolItem) => `${clean(i.name)} added, off`;

const row = (i: ToolItem) => [clean(i.name), i.on ? "on" : "off", ...whence(i)];

/** A check: its row, then each problem on a line of its own, and the tools of a server that's on. */
const checkLines = (c: ToolCheck) =>
  [
    table([row(c)]),
    ...c.problems.map((p) => `  ${clean(p)}`),
    ...(c.tools ? [`  tools: ${c.tools.map(clean).join(", ") || "none"}`] : []),
  ].join("\n");

const NONE: Record<ToolType, string> = { mcp: "No connections", skill: "No skills", hook: "No hooks" };

/** The verbs every kind has: list, verify, doctor, remove. */
export function toolVerbs(cmd: Command, kind: ToolType, out: () => Out): void {
  cmd
    .command("ls", { isDefault: true })
    .description("List them")
    .action(async () => {
      const items = await withClient((c) => c.call("tools.items", { kind }));
      print(out(), items.length ? table(items.map(row)) : NONE[kind], items);
    });
  cmd
    .command("verify <name>")
    .description("Check it, and where it came from")
    .action(async (name: string) => {
      const c = await withClient((cl) => cl.call("tools.verify", { kind, name }));
      print(out(), checkLines(c), c);
    });
  cmd
    .command("doctor [name]")
    .description("Find problems, never starting one that's off")
    .action(async (name?: string) => {
      const all = await withClient((c) => c.call("tools.doctor", { kind, ...(name ? { name } : {}) }));
      print(out(), all.length ? all.map(checkLines).join("\n") : NONE[kind], all);
    });
  cmd
    .command("remove <name>")
    .description("Remove it")
    .action(async (name: string) => {
      await withClient((c) => c.call("tools.remove", { kind, name }));
      print(out(), `Removed ${clean(name)}`, { ok: true });
    });
}
