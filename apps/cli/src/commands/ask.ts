import type { Command } from "commander";
import { ApiCallError, type IonClient } from "@ion/client";
import { ionPaths } from "@ion/config";
import type { EffortLevel } from "@ion/schema";
import { reach } from "../daemon-control.js";
import { fail, NOT_RUNNING, type Out } from "../output.js";
import { createRenderer, type RunEnd } from "../render.js";

type AskOpts = {
  project?: string;
  chat?: string;
  harness?: string;
  model?: string;
  effort?: EffortLevel;
  access?: string;
};

/** Prints the run's events as they arrive and resolves when it finishes. */
function follow(
  client: IonClient,
  started: { chatId: string; runId: string },
  json: boolean,
): Promise<RunEnd> {
  const render = createRenderer();
  return new Promise((resolve) => {
    let done = false;
    const lost = () => {
      if (done) return;
      done = true;
      process.stderr.write("\nLost the connection to ion. The run may have stopped.\n");
      resolve({ status: "failed", code: 1 });
    };
    client.onClose(lost);
    client
      .subscribe({ chatId: started.chatId }, (e) => {
        if (done || e.runId !== started.runId) return;
        if (json) process.stdout.write(`${JSON.stringify(e)}\n`);
        const r = render(e);
        if (!json && r.text) process.stdout.write(r.text);
        if (r.end) {
          done = true;
          resolve(r.end);
        }
      })
      .catch(lost);
  });
}

async function start(client: IonClient, text: string, o: AskOpts) {
  try {
    return await client.call("ask", {
      text,
      ...(o.project ? { projectId: o.project } : {}),
      ...(o.chat ? { chatId: o.chat } : {}),
      ...(o.harness ? { harness: o.harness } : {}),
      ...(o.model ? { model: o.model } : {}),
      ...(o.effort ? { effort: o.effort } : {}),
      ...(o.access === "auto" || o.access === "full" ? { access: o.access } : {}),
    });
  } catch (e) {
    client.close();
    return fail(e instanceof ApiCallError ? e.message : "Something went wrong");
  }
}

export function askCommand(program: Command, out: () => Out) {
  program
    .command("ask <text>")
    .description("Ask a coding agent to do something in a project")
    .option("-p, --project <id>", "Project")
    .option("--chat <id>", "Continue a chat")
    .option("--harness <id>", "claude-code, codex, grok-build or opencode", "claude-code")
    .option("--model <model>", "Model")
    .option("--effort <level>", "low, medium, high or max")
    .option("--access <mode>", "auto (ion decides) or full")
    .action(async (text: string, o: AskOpts) => {
      if (o.access !== undefined && o.access !== "auto" && o.access !== "full") fail("Pick auto or full");
      const up = await reach(ionPaths().dataDir);
      if (!up) fail(NOT_RUNNING, 2);
      const started = await start(up.client, text, o);
      let stopping = false;
      process.on("SIGINT", () => {
        if (stopping) process.exit(130);
        stopping = true;
        void up.client.call("run.interrupt", { runId: started.runId }).catch(() => {});
      });
      const end = await follow(up.client, started, out().json);
      up.client.close();
      process.exit(end.code);
    });
}
