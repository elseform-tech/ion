import type { Command } from "commander";
import { ApiCallError, type IonClient } from "@ion/client";
import { ionPaths } from "@ion/config";
import { type EffortLevel, EV, type IonEvent } from "@ion/schema";
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
  /** commander's `--no-memory`: false. */
  memory?: boolean;
};

/** How long `ion answer` waits for the chat to go on before it ends (ION_ANSWER_WAIT_MS: tests). */
const NEXT_RUN_WAIT_MS = Number(process.env.ION_ANSWER_WAIT_MS) || 15_000;

/** How long `ion ask` stays after a limit for ion's question about it. */
const QUESTION_WAIT_MS = 10_000;

/**
 * The run `ion ask` shows: its own events, and ion's lines after a limit (they have no run). When ion goes on on
 * another agent it follows that run, replaying what it already sent (its run starts just before ion's line).
 */
class Watched {
  /** Null: the chat's next run, whichever it is (after `ion answer`). */
  runId: string | null;
  render = createRenderer();
  private readonly others = new Map<string, IonEvent[]>();

  constructor(runId: string | null) {
    this.runId = runId;
  }

  /** Seen this run's first event: what comes before it is the chat's past (a subscription replays it). */
  private live = false;

  /** Whether to show this event now; another run's are kept, in case ion goes on with it. */
  mine(e: IonEvent): boolean {
    // The chat's next run starts (review of Plan 21 Task 2, 2026-11-23: the old run's answered question was taken for it).
    if (this.runId === null && e.runId && (e.type === EV.runQueued || e.type === EV.runStarted))
      this.runId = e.runId;
    if (this.runId === null) return false;
    if (e.runId === this.runId) {
      this.live = true;
      return true;
    }
    if (!this.live) return false;
    if (e.runId === null) return e.type === EV.chatHandoff;
    this.others.set(e.runId, [...(this.others.get(e.runId) ?? []), e]);
    return false;
  }

  /** ion went on: the newest other run is the one it started; its events so far come back to be shown. */
  switch(): IonEvent[] {
    const runId = [...this.others.keys()].at(-1);
    if (!runId) return [];
    this.runId = runId;
    this.render = createRenderer();
    return this.others.get(runId) ?? [];
  }
}

/**
 * Prints the run's events as they arrive and resolves when it finishes. With no run yet (`runId` null), the chat's
 * next one from now on, once `act` is done (`ion answer`: the answer it goes on with).
 */
export function follow(
  client: IonClient,
  started: { chatId: string; runId: string | null },
  json: boolean,
  act?: () => Promise<unknown>,
): Promise<RunEnd> {
  const w = new Watched(started.runId);
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (end: RunEnd) => {
      if (done) return;
      done = true;
      resolve(end);
    };
    const lost = () => {
      if (done) return;
      process.stderr.write("\nLost the connection to ion. The run may have stopped.\n");
      finish({ status: "failed", code: 1 });
    };
    const show = (e: IonEvent) => {
      if (done) return;
      if (json) process.stdout.write(`${JSON.stringify(e)}\n`);
      const r = w.render(e);
      if (!json && r.text) process.stdout.write(r.text);
      if (r.end) finish(r.end);
      if (r.follow) {
        clearTimeout(timer);
        for (const x of w.switch()) show(x);
      }
      // A limit: ion asks, waits or goes on right after; the run's output ends with that, or soon after.
      const soon = r.soon;
      if (soon) timer = setTimeout(() => finish(soon), QUESTION_WAIT_MS);
    };
    client.onClose(lost);
    client
      .subscribe({ chatId: started.chatId, ...(started.runId ? {} : { fromNow: true }) }, (e) => {
        if (!done && w.mine(e)) show(e);
      })
      .then(async () => {
        if (!act) return;
        await act();
        // Nothing started (a wait until the agent's reset, say): `ion answer` ends instead of hanging.
        setTimeout(() => {
          if (w.runId !== null || done) return;
          process.stdout.write("The chat goes on later.\n");
          finish({ status: "done", code: 0 });
        }, NEXT_RUN_WAIT_MS);
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
      ...(o.memory === false ? { noMemory: true } : {}),
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
    .option(
      "--harness <id>",
      "claude-code, codex, grok-build or opencode (default: the chat's, else one signed in)",
    )
    .option("--model <model>", "Model")
    .option("--effort <level>", "low, medium, high or max")
    .option("--access <mode>", "auto (ion decides) or full")
    .option("--no-memory", "Don't remember this chat")
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
