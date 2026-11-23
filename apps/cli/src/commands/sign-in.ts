import { ApiCallError, type IonClient } from "@ion/client";
import type { HarnessInfo, SignInResult } from "@ion/schema";
import { clean } from "../sanitize.js";

/** About 10 minutes of reads, 2 seconds apart. */
const POLLS = 300;
const EVERY_MS = 2000;

/** Resolves after `ms`, or at once when `stop` aborts. */
const pause = (ms: number, stop: AbortSignal) =>
  new Promise<void>((r) => {
    if (stop.aborted) return r();
    const t = setTimeout(r, ms);
    stop.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
  });

/**
 * Waits for a sign-in ion started to end: the agent as ion reads it then. On Ctrl-C (`stop`) or giving up, the
 * daemon's sign-in is stopped too, so none is left running (review of #35, 2026-11-23).
 */
export async function waitForSignIn(
  c: Pick<IonClient, "call">,
  id: string,
  o: { stop: AbortSignal; polls?: number; everyMs?: number },
): Promise<HarnessInfo | undefined> {
  // An agent the list doesn't show (the fake one outside debug mode): its sign-in is stopped, and that's an error.
  const read = async (): Promise<HarnessInfo> => {
    const h = (await c.call("harnesses.list", {})).find((x) => x.id === id);
    if (h) return h;
    await c.call("harness.cancelLogin", { id });
    throw new ApiCallError("invalid", `Unknown agent: ${id}`);
  };
  for (let i = 0; i < (o.polls ?? POLLS) && !o.stop.aborted; i++) {
    // Read once more when it's over: a list that began while it ended may still hold the state from before.
    if (!(await read()).signingIn) return read();
    await pause(o.everyMs ?? EVERY_MS, o.stop);
  }
  await c.call("harness.cancelLogin", { id });
  return undefined;
}

/** What to do with a sign-in: open its page (and confirm its code), or type its command in a terminal. */
export function signInLines(r: SignInResult): string {
  if (r.kind === "command") return `Run in a terminal: ${clean(r.command)}`;
  const lines = [r.url && `Open: ${clean(r.url)}`, r.code && `Code: ${clean(r.code)}`].filter(Boolean);
  return lines.length ? lines.join("\n") : "Finish in your browser";
}
