import type { Command } from "commander";
import { ApiCallError, type IonClient } from "@ion/client";
import { connect, withClient } from "../connect.js";
import { fail, type Out, print } from "../output.js";
import { needText } from "../render.js";
import { follow } from "./ask.js";

type Pick = { choice: number } | { text: string };
type Scope = "chat" | "project" | "everywhere";

/** A refused call exits 1 with ion's own message. */
const refused = (e: unknown): never => fail(e instanceof ApiCallError ? e.message : "Something went wrong");

/**
 * Answers, then shows the chat's reply as it comes, to its end (Plan 21 audit, 2026-11-23: after `ion answer` no
 * command could show what the chat said next). A question ion doesn't know is refused as before.
 */
async function answerAndFollow(c: IonClient, needId: string, pick: Pick, scope: Scope): Promise<number> {
  const need = (await c.call("needs.list", {}).catch(refused)).find((n) => n.needId === needId);
  const answer = async () => {
    await c.call("need.answer", { needId, ...pick, scope }).catch(refused);
    process.stdout.write("Answered\n");
  };
  if (!need) return answer().then(() => 0);
  return (await follow(c, { chatId: need.chatId, runId: null }, false, answer)).code;
}

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
    .option("--remember", "Remember this answer for this exact action in the project")
    .action(async (id: string, words: string[], o: { always?: string; remember?: boolean }) => {
      if (o.always && !WHERE.includes(o.always)) fail("Pick project or everywhere");
      const scope = (o.remember ? "project" : (o.always ?? "chat")) as "chat" | "project" | "everywhere";
      const answer = words.join(" ");
      const pick = /^\d+$/.test(answer) ? { choice: Number(answer) } : { text: answer };
      if (out().json) {
        await withClient((c) => c.call("need.answer", { needId: id, ...pick, scope }));
        return print(out(), "Answered", { ok: true });
      }
      const c = await connect();
      const code = await answerAndFollow(c, id, pick, scope);
      c.close();
      process.exit(code);
    });
}
