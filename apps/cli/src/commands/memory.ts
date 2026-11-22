import type { MemoryInfo } from "@ion/schema";
import type { Command } from "commander";
import { withClient } from "../connect.js";
import { openFolder } from "../daemon-control.js";
import { type Out, print } from "../output.js";
import { clean, text } from "../sanitize.js";

/** A file in one line: where it is, its type (a to-do's state and date), its name and description. */
const lineOf = (m: MemoryInfo) => {
  const kind = [m.type, ...(m.type === "todo" ? [m.status ?? "open", m.due ?? ""] : [])].filter(Boolean);
  return [m.memoryId, kind.join(" "), `${m.name}: ${m.description}`].map(clean).join("  ");
};

export function memoryCommands(program: Command, out: () => Out) {
  const m = program.command("memory").description("What ion remembers");
  m.command("ls")
    .description("List it")
    .option("-p, --project <id>", "Project")
    .option("--type <type>", "preference, fact, person, todo or reference")
    .option("--open", "Open to-dos only")
    .action(async (o: { project?: string; type?: string; open?: boolean }) => {
      const args = {
        ...(o.project ? { projectId: o.project } : {}),
        ...(o.type ? { type: o.type as MemoryInfo["type"] } : {}),
        ...(o.open ? { open: true } : {}),
      };
      const list = await withClient((c) => c.call("memory.list", args));
      print(out(), list.length ? list.map(lineOf).join("\n") : "No memory", list);
    });
  m.command("show <name>")
    .description("Show one")
    .action(async (name: string) => {
      const f = await withClient((c) => c.call("memory.read", { name }));
      const kind = [f.type, ...(f.type === "todo" ? [f.status ?? "open", f.due ?? ""] : [])].filter(Boolean);
      const head = [f.name, f.description, `${kind.join(" ")}  ${f.path}`].map(clean);
      print(out(), `${head.join("\n")}\n\n${text(f.text)}`, f);
    });
  m.command("search <words>")
    .description("Find by words")
    .action(async (q: string) => {
      const list = await withClient((c) => c.call("memory.search", { q }));
      print(out(), list.length ? list.map(lineOf).join("\n") : "Nothing found", list);
    });
  m.command("forget <name>")
    .description("Forget it")
    .action(async (name: string) => {
      await withClient((c) => c.call("memory.forget", { memoryId: name }));
      print(out(), "Forgotten", { ok: true });
    });
  m.command("open")
    .description("Open the folder")
    .action(async () => {
      const { path } = await withClient((c) => c.call("memory.folder", {}));
      // Only at a terminal: a script or a pipe gets the path alone.
      if (process.stdout.isTTY && !out().json) openFolder(path);
      print(out(), path, { path });
    });
}
