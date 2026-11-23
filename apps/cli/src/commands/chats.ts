import type { Command } from "commander";
import { withClient } from "../connect.js";
import { type Out, print, table } from "../output.js";
import { clean } from "../sanitize.js";

export function chatsCommands(program: Command, out: () => Out) {
  const ch = program
    .command("chats")
    .description("Your chats")
    .action(async () => {
      const list = (await withClient((c) => c.call("chats.list", {}))).filter((x) => !x.archived);
      const rows = list.map((x) =>
        [x.chatId, x.waiting ? "waiting" : (x.lastRunStatus ?? "-"), x.projectId ?? "-", x.title].map(clean),
      );
      print(out(), rows.length ? table(rows) : "No chats", list);
    });
  ch.command("archive <id>")
    .description("Archive a chat; its branch stays")
    .action(async (id: string) => {
      await withClient((c) => c.call("chat.archive", { chatId: id }));
      print(out(), "Archived", { ok: true });
    });
}
