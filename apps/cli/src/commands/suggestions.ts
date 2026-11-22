import type { Command } from "commander";
import { withClient } from "../connect.js";
import { type Out, print } from "../output.js";
import { clean } from "../sanitize.js";

/** ion chief's open suggestions, and your answer to one. */
export function suggestionsCommands(program: Command, out: () => Out) {
  const s = program.command("suggestions").description("What ion suggests");
  s.command("ls", { isDefault: true })
    .description("List them")
    .action(async () => {
      const list = await withClient((c) => c.call("suggestions.list", {}));
      const rows = list.map((x) =>
        [x.suggestionId, x.projectId, x.title]
          .map(clean)
          .join("  ")
          .concat(`\n  ${clean(x.detail)}`),
      );
      print(out(), rows.length ? rows.join("\n") : "No suggestions", list);
    });
  const answer = (name: string, what: string, args: { keep: boolean; mute?: boolean }, done: string) =>
    s
      .command(`${name} <id>`)
      .description(what)
      .action(async (id: string) => {
        await withClient((c) => c.call("suggestion.answer", { suggestionId: id, ...args }));
        print(out(), done, { ok: true });
      });
  answer("take", "Do it: add the routine, resume the chat, or mark the to-do done", { keep: true }, "Done");
  answer("dismiss", "Not now", { keep: false }, "Dismissed");
  answer("mute", "Not now, and fewer like this", { keep: false, mute: true }, "Muted");
}
