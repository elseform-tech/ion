import type { DreamMode, MemoryInfo } from "@ion/schema";
import type { Command } from "commander";
import { withClient } from "../connect.js";
import { openFolder } from "../daemon-control.js";
import { fail, type Out, print } from "../output.js";
import { clean, text } from "../sanitize.js";

/** A file in one line: where it is, its type (a to-do's state and date), its name and description (once, if alike). */
const lineOf = (m: MemoryInfo) => {
  const todo = m.type === "todo" ? [m.status ?? "open", m.due ?? ""] : [];
  const kind = [m.type, ...todo, m.suggested ? "suggested" : ""].filter(Boolean);
  const words = m.description === m.name ? m.name : `${m.name}: ${m.description}`;
  return [m.memoryId, kind.join(" "), words].map(clean).join("  ");
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
  m.command("keep <name>")
    .description("Keep a chat's suggestion for every project")
    .action(async (name: string) => {
      const r = await withClient((c) => c.call("memory.keep", { path: name }));
      print(out(), "Kept for every project", r);
    });
  memorySwitch(m, out);
  tidyCommand(m, out);
}

const TIDY: DreamMode[] = ["off", "nightly", "weekly"];

/**
 * `ion memory tidy [off|nightly|weekly]` (Plan 21 Task 4): the app tucks Tidy memory under More; the CLI reaches it
 * too. With no word, says how often it runs.
 */
function tidyCommand(m: Command, out: () => Out) {
  m.command("tidy [how]")
    .description("How often it tidies: off, nightly or weekly")
    .action(async (how?: string) => {
      if (how !== undefined && !TIDY.includes(how as DreamMode)) fail("Pick off, nightly or weekly");
      const s = await withClient((c) =>
        how
          ? c.call("settings.set", { patch: { dream: { mode: how as DreamMode } } })
          : c.call("settings.get", {}),
      );
      print(out(), `Tidy memory: ${s.dream.mode}`, s.dream);
    });
}

/** `ion memory on|off [-p <project>]` and `ion memory open`. */
function memorySwitch(m: Command, out: () => Out) {
  // The user, 2026-11-23: "a way to disable memory". Off: agents and ions get none, and nothing new is written; your
  // files stay.
  for (const on of [true, false])
    m.command(on ? "on" : "off")
      .description(on ? "Turn it on" : "Turn it off")
      .option("-p, --project <id>", "Project")
      .action(async (o: { project?: string }) => {
        const memory = o.project ? { projects: { [o.project]: on } } : { on };
        const s = await withClient((c) => c.call("settings.set", { patch: { memory } }));
        const where = o.project ? ` in ${clean(o.project)}` : "";
        print(out(), `Memory ${on ? "on" : "off"}${where}`, s.memory);
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
