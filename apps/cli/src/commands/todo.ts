import type { MemoryInfo } from "@ion/schema";
import type { Command } from "commander";
import { withClient } from "../connect.js";
import { type Out, print } from "../output.js";
import { clean } from "../sanitize.js";

/** A to-do in one line: where it is, its day, its name. */
const lineOf = (m: MemoryInfo) =>
  [m.memoryId, ...(m.due ? [`due ${m.due}`] : []), m.name].map(clean).join("  ");

/** Those with a day first, soonest first; then the rest, as listed. */
const byDue = (a: MemoryInfo, b: MemoryInfo) => (a.due ?? "9").localeCompare(b.due ?? "9");

async function list(out: () => Out) {
  const open = await withClient((c) => c.call("memory.list", { type: "todo", open: true }));
  const sorted = [...open].sort(byDue);
  print(out(), sorted.length ? sorted.map(lineOf).join("\n") : "Nothing to do", sorted);
}

export function todoCommands(program: Command, out: () => Out) {
  const t = program
    .command("todo")
    .description("Your to-dos")
    .action(() => list(out));
  t.command("ls")
    .description("List what's open")
    .action(() => list(out));
  t.command("add <text>")
    .description("Add one")
    .option("-p, --project <id>", "Project")
    .option("--due <date>", "Day it's due (YYYY-MM-DD)")
    .action(async (text: string, o: { project?: string; due?: string }) => {
      const args = { text, ...(o.project ? { projectId: o.project } : {}), ...(o.due ? { due: o.due } : {}) };
      const m = await withClient((c) => c.call("todo.add", args));
      const whose = o.project ? `${o.project}'s` : "your";
      const day = m.due ? ` (${m.due})` : "";
      print(out(), clean(`Added to ${whose} to-dos: ${m.name}${day}`), m);
    });
  t.command("done <name>")
    .description("Mark one done")
    .action(async (name: string) => {
      const m = await withClient((c) => c.call("todo.done", { name }));
      print(out(), clean(`Done: ${m.name}`), m);
    });
}
