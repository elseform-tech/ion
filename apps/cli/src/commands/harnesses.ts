import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { ApiCallError, type IonClient } from "@ion/client";
import type { HarnessInfo, SignInResult, SignOutResult } from "@ion/schema";
import { withClient } from "../connect.js";
import { fail, type Out, print } from "../output.js";
import { clean } from "../sanitize.js";

const status = (h: HarnessInfo) => {
  if (!h.installed) return "Not installed";
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

/** Waits for a sign-in ion started to end (10 minutes at most): the agent as ion reads it then. */
async function signedInAfter(c: IonClient, id: string): Promise<HarnessInfo | undefined> {
  for (let i = 0; i < 300; i++) {
    const h = (await c.call("harnesses.list", {})).find((x) => x.id === id);
    if (!h?.signingIn) return h;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return undefined;
}

/** What to do with a sign-in: open its page (and confirm its code), or type its command in a terminal. */
const signInLines = (r: SignInResult) =>
  r.kind === "command"
    ? `Run in a terminal: ${clean(r.command)}`
    : [r.url && `Open: ${clean(r.url)}`, r.code && `Code: ${clean(r.code)}`].filter(Boolean).join("\n");

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
  // The user, 2026-11-22: your agent order (Settings → Agents), for handoffs, Pick by usage and ions' chats.
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
        const h = await signedInAfter(c, id);
        print(out(), h ? status(h) : "Still waiting", h ?? null);
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
}
