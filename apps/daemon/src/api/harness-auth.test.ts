import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EV, type HarnessInfo } from "@ion/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getHarness } from "../adapters/registry.js";
import { Readiness } from "../runs/ready.js";
import { EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { asListed, type Ctx, handlers, harnessInfos } from "./commands.js";

// Everything here runs on the fake agent's scripted sign-in and sign-out: never a real agent's (AGENTS.md).
const ENV = [
  "ION_ALLOW_FAKE",
  "ION_FAKE_SIGNED_OUT",
  "ION_FAKE_LOGIN",
  "ION_FAKE_LOGIN_MS",
  "ION_FAKE_LOGIN_CLEARS",
];
let saved: Record<string, string | undefined>;
let ctx: Ctx;
let store: EventStore;

beforeEach(async () => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.ION_ALLOW_FAKE = "1";
  process.env.ION_FAKE_LOGIN_MS = "60";
  store = new EventStore(openDb(":memory:"), allViews);
  const home = mkdtempSync(join(tmpdir(), "ion-auth-"));
  ctx = { store, db: store.db, configFile: join(home, "config.toml") } as unknown as Ctx;
  // What the last test left: read anew (here only: ion reads it again itself after a sign-in or sign-out).
  await harnessInfos.refresh("fake");
});

afterEach(async () => {
  await handlers["harness.cancelLogin"]({ id: "fake" }, ctx);
  for (const k of ENV)
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
});

const call = <K extends "harness.login" | "harness.logout">(k: K, a: { id: string; confirm?: boolean }) =>
  handlers[k](a, ctx);
/** The fake agent as the app lists it (read alone: the list would ask every real agent too). */
const fake = async (): Promise<HarnessInfo> => asListed((await harnessInfos.one("fake"))!);
const until = async (ok: () => Promise<boolean>) => {
  for (let i = 0; i < 100 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 20));
};

describe("signing in and out of an agent", () => {
  // The user, 2026-11-23: sign out asks first and runs the agent's own logout (it signs the agent out everywhere).
  it("sign out asks first and runs the agent's own logout", async () => {
    await expect(call("harness.logout", { id: "fake" })).rejects.toThrow(
      "Sign out of Fake? This signs Fake out on this Mac, not just in ion.",
    );
    expect((await getHarness("fake")!.adapter.auth.status()).signedIn).toBe(true);
    expect(await call("harness.logout", { id: "fake", confirm: true })).toEqual({
      kind: "done",
      signedIn: false,
    });
    expect((await getHarness("fake")!.adapter.auth.status()).signedIn).toBe(false);
  });

  it("sign out waits for the agent's chats: it's refused while it works in one", async () => {
    for (const [chatId, runId] of [
      ["c1", "r1"],
      ["c2", "r2"],
    ] as const) {
      store.append({ chatId, runId, origin: "daemon", type: EV.runQueued, data: { harness: "fake" } });
    }
    await expect(call("harness.logout", { id: "fake", confirm: true })).rejects.toThrow(
      "Fake is working in 2 chats. Sign out after they finish.",
    );
    expect((await getHarness("fake")!.adapter.auth.status()).signedIn).toBe(true);
  });

  // The user, 2026-11-23: readiness refreshes after sign out and sign in (at once, not a minute later).
  it("readiness refreshes after sign out and sign in", async () => {
    const ready = new Readiness();
    expect((await fake()).signedIn).toBe(true);
    await ready.check(getHarness("fake")!);
    await call("harness.logout", { id: "fake", confirm: true });
    expect(await fake()).toMatchObject({
      signedIn: false,
      signIn: { command: "ion fake login", inApp: true },
    });
    // A check that passed a moment ago doesn't hold once you sign out.
    await expect(ready.check(getHarness("fake")!)).rejects.toThrow("Fake isn't signed in");
    await call("harness.login", { id: "fake" });
    await until(async () => (await fake()).signedIn);
    const back = await fake();
    expect(back.signedIn).toBe(true);
    expect(back.signingIn).toBeUndefined();
    await ready.check(getHarness("fake")!);
  });

  // The user, 2026-11-23: a login that gives a URL shows it (its page and code, while it waits).
  it("a login that gives a URL shows it", async () => {
    process.env.ION_FAKE_SIGNED_OUT = "1";
    process.env.ION_FAKE_LOGIN_MS = "60000";
    const shown = { url: "https://example.test/fake-sign-in", code: "FAKE-0001" };
    expect(await call("harness.login", { id: "fake" })).toEqual({ kind: "started", ...shown });
    expect((await fake()).signingIn).toEqual(shown);
    // Asked again while it waits: the same sign-in, not a second one.
    expect(await call("harness.login", { id: "fake" })).toEqual({ kind: "started", ...shown });
    await call("harness.cancelLogin", { id: "fake" });
    expect((await fake()).signingIn).toBeUndefined();
  });

  it("an agent that's signed in isn't signed in again (Codex's login clears the sign-in it has)", async () => {
    await expect(call("harness.login", { id: "fake" })).rejects.toThrow("Fake is already signed in");
    process.env.ION_FAKE_SIGNED_OUT = "1";
    process.env.ION_FAKE_LOGIN_CLEARS = "1";
    await expect(call("harness.login", { id: "fake" })).rejects.toThrow(
      "Sign in to Fake? Starting it clears any Fake sign-in on this Mac.",
    );
    expect((await call("harness.login", { id: "fake", confirm: true })).kind).toBe("started");
  });

  // The user, 2026-11-23: an agent without a login shows its command (its login needs a terminal).
  it("an agent without a login shows its command", async () => {
    process.env.ION_FAKE_SIGNED_OUT = "1";
    process.env.ION_FAKE_LOGIN = "command";
    await harnessInfos.refresh("fake");
    expect(await call("harness.login", { id: "fake" })).toEqual({
      kind: "command",
      command: "ion fake login",
    });
    expect((await fake()).signIn).toEqual({ command: "ion fake login", inApp: false });
    // opencode's login and logout ask in a terminal: only their commands, and nothing is run.
    const opencode = getHarness("opencode")!.adapter.auth;
    expect([opencode.login.start, opencode.logout.run]).toEqual([undefined, undefined]);
    expect(await call("harness.logout", { id: "opencode", confirm: true })).toEqual({
      kind: "command",
      command: "opencode auth logout",
    });
  });

  // The user, 2026-11-23: nothing secret is kept or shown: only the page and the code, never in the daemon's log.
  it("nothing secret is kept or shown", async () => {
    process.env.ION_FAKE_SIGNED_OUT = "1";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await call("harness.login", { id: "fake" });
    expect(Object.keys(r).sort()).toEqual(["code", "kind", "url"]);
    expect(Object.keys((await fake()).signingIn ?? {}).sort()).toEqual(["code", "url"]);
    await until(async () => (await fake()).signedIn);
    const said = JSON.stringify([...log.mock.calls, ...info.mock.calls]);
    expect(said).not.toContain("FAKE-0001");
    expect(said).not.toContain("example.test");
    log.mockRestore();
    info.mockRestore();
  });
});
