import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type IonClient } from "@ion/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer } from "./server.js";
import { startHandlers } from "./start.js";
import type { Ctx } from "./commands.js";
import { EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";

// Only the fake agent, signed out: no real agent's CLI is asked (AGENTS.md).
process.env.ION_ALLOW_FAKE = "1";
process.env.ION_FAKE_SIGNED_OUT = "1";
vi.mock("../adapters/registry.js", async (real) => ({
  ...(await real<typeof import("../adapters/registry.js")>()),
  harnessIds: () => ["fake"],
  listedHarnessIds: () => ["fake"],
}));

// Plan 21 (the user, 2026-11-22: "if that makes the product even easier to use even for beginners"): a brand-new ion
// opens on a first-run screen (your agents, pick a folder, a message box); `start.status` says when, and each agent's
// one-line fix. Plan 21 audit, 2026-11-23: a beginner met an empty chat box, ion's empty `default` project, and no way
// to add their own folder from the app.
describe("start.status", () => {
  let home: string;
  let srv: Awaited<ReturnType<typeof startServer>>;
  let client: IonClient;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "ion-start-"));
    srv = await startServer({ dataDir: join(home, "data"), configFile: join(home, "config.toml"), port: 0 });
    client = await connect({ port: srv.port, token: srv.token });
  });
  afterEach(async () => {
    client.close();
    await srv.close();
  });

  const folder = (name: string) => {
    const p = join(mkdtempSync(join(tmpdir(), "ion-folder-")), name);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "index.html"), "<h1>hi</h1>\n");
    return p;
  };

  it("first run shows only with no projects and no chats", async () => {
    const s = await client.call("start.status", {});
    expect(s).toMatchObject({ projects: 0, chats: 0, firstRun: true });
    // Every agent ion lists has a row: ready, or the command that gets it there.
    expect(s.agents).toEqual([
      { id: "fake", label: "Fake", state: "signIn", command: "ion fake login", inApp: true },
    ]);
  });

  it("an existing user never sees it: a project of your own, or any chat (even in default)", async () => {
    await client.call("projects.add", { path: folder("site") });
    expect(await client.call("start.status", {})).toMatchObject({ projects: 1, firstRun: false });
    const other = mkdtempSync(join(tmpdir(), "ion-start-"));
    const srv2 = await startServer({
      dataDir: join(other, "data"),
      configFile: join(other, "config.toml"),
      port: 0,
    });
    const c2 = await connect({ port: srv2.port, token: srv2.token });
    try {
      await c2.call("chat.create", { title: "an old chat", projectId: null });
      expect(await c2.call("start.status", {})).toMatchObject({ projects: 0, chats: 1, firstRun: false });
    } finally {
      c2.close();
      await srv2.close();
    }
  });

  it("picking a non-git folder sets up git and says so", async () => {
    const path = folder("tip-calc");
    const added = await client.call("projects.add", { path });
    expect(added).toMatchObject({ id: "tip-calc", path, gitSetUp: true });
    expect(existsSync(join(path, ".git"))).toBe(true);
  });
});

// The tour, 2026-11-23: on a fresh opencode home, bare `ion` waited over 60 s for opencode's first read. start.status
// waits a few seconds at most, and an agent still being read says so.
describe("start.status on a fresh daemon", () => {
  it("doesn't wait on an agent still being read: it shows as checking", async () => {
    const home = mkdtempSync(join(tmpdir(), "ion-start-"));
    const store = new EventStore(openDb(":memory:"), allViews);
    const ctx = { store, db: store.db, configFile: join(home, "config.toml") } as unknown as Ctx;
    const agents = vi.fn(async () => []);
    const h = startHandlers({ agents, ids: () => ["opencode"] });
    const s = await h["start.status"]({}, ctx);
    expect(agents).toHaveBeenCalledWith(ctx.configFile, { fresh: false, waitMs: 4000 });
    expect(s.agents).toEqual([{ id: "opencode", label: "opencode", state: "checking" }]);
  });
});
