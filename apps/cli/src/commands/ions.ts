import type { Command } from "commander";
import { withClient } from "../connect.js";
import { type Out, print, table } from "../output.js";
import { clean } from "../sanitize.js";

/** `ion ions`: ion chief and each project's ion, with what each last said; `ion ions message` talks to one. */
export function ionsCommands(program: Command, out: () => Out) {
  const ions = program
    .command("ions")
    .description("ion and your projects' ions")
    .action(async () => {
      const list = await withClient((c) => c.call("ions.list", {}));
      print(out(), table(list.map((x) => [x.ionId, x.name, x.last ?? "-"].map(clean))), list);
    });
  ions
    .command("message <ion> <text...>")
    .description("Message an ion: chief, or a project's")
    .action(async (ionId: string, words: string[]) => {
      await withClient((c) => c.call("ion.message", { ionId, text: words.join(" ") }));
      print(out(), "Sent", { ok: true });
    });
}
