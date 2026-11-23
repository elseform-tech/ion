import type { HarnessInfo } from "@ion/schema";
import { describe, expect, it, vi } from "vitest";
import { signInLines, waitForSignIn } from "./sign-in.js";

const agent = (signingIn: boolean): HarnessInfo => ({
  ...{ id: "fake", label: "Fake", installed: true, signedIn: !signingIn, models: [], defaultModel: null },
  ...(signingIn ? { signingIn: { url: "https://example.test/p", code: null } } : {}),
});

/** A daemon whose sign-in waits `waits` reads, then ends. */
function client(waits: number) {
  let n = 0;
  const call = vi.fn(async (cmd: string) => {
    if (cmd === "harnesses.list") return [agent(n++ < waits)];
    return { ok: true };
  });
  return { call } as unknown as Parameters<typeof waitForSignIn>[0] & { call: typeof call };
}

// Review of #35, 2026-11-23: Ctrl-C, or the CLI giving up after 10 minutes, left the daemon's sign-in running.
describe("review of #35, 2026-11-23: ion harnesses login", () => {
  it("waits for the sign-in to end and says how it ended", async () => {
    const c = client(2);
    const h = await waitForSignIn(c, "fake", { stop: new AbortController().signal, everyMs: 1 });
    expect(h?.signedIn).toBe(true);
    expect(c.call).not.toHaveBeenCalledWith("harness.cancelLogin", { id: "fake" });
  });

  it("stops the daemon's sign-in when it gives up", async () => {
    const c = client(1000);
    const gaveUp = await waitForSignIn(c, "fake", {
      stop: new AbortController().signal,
      everyMs: 1,
      polls: 3,
    });
    expect(gaveUp).toBeUndefined();
    expect(c.call).toHaveBeenCalledWith("harness.cancelLogin", { id: "fake" });
  });

  it("stops the daemon's sign-in on Ctrl-C", async () => {
    const c = client(1000);
    const stop = new AbortController();
    const waiting = waitForSignIn(c, "fake", { stop: stop.signal, everyMs: 5 });
    stop.abort();
    expect(await waiting).toBeUndefined();
    expect(c.call).toHaveBeenCalledWith("harness.cancelLogin", { id: "fake" });
  });

  it("never prints an empty line for a sign-in with no page or code", () => {
    expect(signInLines({ kind: "started", url: null, code: null })).toBe("Finish in your browser");
    expect(signInLines({ kind: "started", url: "https://example.test/p", code: "AB12-CD34" })).toBe(
      "Open: https://example.test/p\nCode: AB12-CD34",
    );
  });
});
