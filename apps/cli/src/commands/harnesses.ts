import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { ApiCallError } from "@ion/client";
import type { HarnessInfo, JudgeCheckInfo, SignOutResult } from "@ion/schema";
import { withClient } from "../connect.js";
import { fail, type Out, print } from "../output.js";
import { clean } from "../sanitize.js";
import { signInLines, waitForSignIn } from "./sign-in.js";

const status = (h: HarnessInfo) => {
  if (!h.installed) return "Not installed";
  if (h.signInUnknown) return "Couldn't tell if signed in";
  return h.signedIn ? "Signed in" : "Not signed in";
};

/** `<id>  <status>  <model (default), model, …>` */
const row = (h: HarnessInfo) => {
  const models = h.models.map((m) => (m.id === h.defaultModel ? `${m.id} (default)` : m.id)).join(", ");
  return [h.id, status(h), models].filter(Boolean).map(clean).join("  ");
};

/** ion's question before it runs something, answered here: yes only with "y". */
async function asked(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return fail(`${question} Add --yes to go ahead.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

/**
 * A call that ion may first answer with a question (sign out: it signs the agent out on this Mac): asked here, then
 * made again with your yes. With --yes, made with it at once.
 */
async function withYes<T>(yes: boolean, call: (confirm: boolean) => Promise<T>): Promise<T | null> {
  try {
    return await call(yes);
  } catch (e) {
    const q = e instanceof ApiCallError && !yes && e.code === "confirm" ? e.message : null;
    if (!q) throw e;
    return (await asked(q)) ? call(true) : null;
  }
}

/** After a sign-out: the command to type, or whether the agent now reads signed in. */
function signOutLine(r: SignOutResult): string {
  if (r.kind === "command") return `Run in a terminal: ${clean(r.command)}`;
  return r.signedIn ? "Still signed in" : "Not signed in";
}

export function harnessesCommand(program: Command, out: () => Out) {
  const h = program
    .command("harnesses")
    .description("Coding agents and their models")
    .action(async () => {
      const list = await withClient((c) => c.call("harnesses.list", {}));
      print(out(), list.map(row).join("\n"), list);
    });
  // The user, 2026-11-22: your agent order (Settings → Agents → More: Prefer in this order; 2026-11-24).
  h.command("order <ids...>")
    .description("Put agents in order, best first")
    .action(async (ids: string[]) => {
      const s = await withClient((c) => c.call("settings.set", { patch: { agentOrder: ids } }));
      print(out(), s.agentOrder.map(clean).join(", "), s.agentOrder);
    });
  // The user, 2026-11-23: sign in and out of each agent from ion (its own login and logout).
  h.command("login <id>")
    .description("Sign in to an agent")
    .option("--yes", "Go ahead without asking")
    .action((id: string, o: { yes?: boolean }) =>
      withClient(async (c) => {
        const r = await withYes(!!o.yes, (confirm) => c.call("harness.login", { id, confirm }));
        if (!r) return;
        print(out(), signInLines(r), r);
        if (r.kind !== "started" || out().json) return;
        // Ctrl-C stops the daemon's sign-in too, not only this wait.
        const stop = new AbortController();
        const onInt = () => stop.abort();
        process.once("SIGINT", onInt);
        // ion stopped meanwhile: its sign-in stopped with it. Not this command's own close once it's done.
        let done = false;
        c.onClose(() => done || fail("ion stopped"));
        const h = await waitForSignIn(c, id, { stop: stop.signal }).finally(() => {
          done = true;
          process.off("SIGINT", onInt);
        });
        print(out(), h ? status(h) : "Stopped", h ?? null);
      }),
    );
  h.command("logout <id>")
    .description("Sign out of an agent, on this Mac")
    .option("--yes", "Go ahead without asking")
    .action((id: string, o: { yes?: boolean }) =>
      withClient(async (c) => {
        const r = await withYes(!!o.yes, (confirm) => c.call("harness.logout", { id, confirm }));
        if (!r) return;
        print(out(), signOutLine(r), r);
      }),
    );
  checkJudgeCommand(h, out);
}

/** "Checked as judge on <model>: nothing dangerous allowed; 57 of 59 as expected, 2 unsure", or what it allowed. */
function judgeLine(r: JudgeCheckInfo): string {
  const counts = `${r.agreement} of ${r.cases} as expected, ${r.unsure} unsure`;
  if (r.pass) return `Checked as judge on ${clean(r.model)}: nothing dangerous allowed; ${counts}`;
  const why = r.dangerous.length ? `allowed ${r.dangerous.map(clean).join(", ")}` : "didn't answer enough";
  return `Not a judge on ${clean(r.model)}: ${why}; ${counts}`;
}

/** `ion harnesses check-judge <id>` (PR #36 re-review, 2026-11-23): ion checks the judge on your own agents. */
function checkJudgeCommand(h: Command, out: () => Out) {
  h.command("check-judge <id>")
    .description("Check an agent as Auto's judge (runs ion's judge cases on it)")
    .action((id: string) =>
      withClient(async (c) => {
        const r = await c.call("judge.check", { harness: id });
        print(out(), judgeLine(r), r);
      }),
    );
}
