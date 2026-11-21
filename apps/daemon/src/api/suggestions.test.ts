import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type IonClient } from "@ion/client";
import { DEFAULT_CONFIG, loadUserConfig, saveUserConfig } from "@ion/config";
import { EV } from "@ion/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { startServer } from "./server.js";

const repo = (name: string) => {
  const p = join(mkdtempSync(join(tmpdir(), "ion-repo-")), name);
  mkdirSync(p, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: p });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "init");
  return p;
};

const until = async (f: () => boolean | Promise<boolean>, ms: number) => {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

// Plan 11: ion chief's suggestions, through the API, over a daemon restart.
describe("ion chief's suggestions", () => {
  let home: string;
  let configFile: string;
  let srv: Awaited<ReturnType<typeof startServer>> | undefined;
  let client: IonClient | undefined;

  const start = async () => {
    srv = await startServer({ dataDir: join(home, "data"), configFile, port: 0 });
    client = await connect({ port: srv.port, token: srv.token });
    return client;
  };
  const stop = async () => {
    client?.close();
    await srv?.close();
    client = undefined;
    srv = undefined;
  };
  /** Writes events straight into ion's store while it's stopped (what happened days ago). */
  const past = (events: { chatId: string; type: string; data: Record<string, unknown>; ts: string }[]) => {
    const db = openDb(join(home, "data", "ion.db"));
    const store = new EventStore(db, allViews);
    for (const e of events) store.append({ ...e, runId: null, origin: "daemon", type: e.type as never });
    db.close();
  };

  beforeEach(() => {
    process.env.ION_ALLOW_FAKE = "1";
    home = mkdtempSync(join(tmpdir(), "ion-home-"));
    configFile = join(home, "config.toml");
    mkdirSync(join(home, "data"), { recursive: true });
    saveUserConfig(configFile, {
      ...DEFAULT_CONFIG,
      projects: [{ id: "app", path: repo("app"), starred: false, harness: "fake" }],
    });
  });
  afterEach(stop);

  it("suggests a routine for what you asked on 3 days; taking it adds the routine", async () => {
    past(
      [3, 2, 1].map((n) => ({
        chatId: "ion:app",
        type: EV.ionHeard,
        data: { text: "Run the e2e suite" },
        ts: daysAgo(n),
      })),
    );
    const c = await start();
    await until(async () => (await c.call("suggestions.list", {})).length > 0, 5000);
    const [s] = await c.call("suggestions.list", {});
    expect(s).toMatchObject({
      kind: "routine",
      projectId: "app",
      title: "Make “Run the e2e suite” a routine?",
    });
    await c.call("suggestion.answer", { suggestionId: s!.suggestionId, keep: true });
    const app = loadUserConfig(configFile).config.projects[0]!;
    expect(app.routines).toEqual([
      expect.objectContaining({ name: "Run the e2e suite", text: "Run the e2e suite" }),
    ]);
    expect(await c.call("suggestions.list", {})).toEqual([]);
    await expect(c.call("suggestion.answer", { suggestionId: s!.suggestionId, keep: false })).rejects.toThrow(
      "That suggestion is gone",
    );
  });

  it("suggests resuming a stalled chat with changes; Resume sends it on, on its own agent", async () => {
    const c = await start();
    const { chatId } = await c.call("ask", { projectId: "app", text: "edit", harness: "fake" });
    await until(async () => (await c.call("chats.list", {}))[0]?.lastRunStatus === "done", 10_000);
    await stop();
    // It failed four days ago, and nobody touched it since.
    past([{ chatId, type: EV.runFinished, data: { status: "failed" }, ts: daysAgo(4) }]);
    const again = await start();
    await until(async () => (await again.call("suggestions.list", {})).length > 0, 5000);
    const [s] = await again.call("suggestions.list", {});
    expect(s).toMatchObject({ kind: "stalled", title: "Resume “edit”?", detail: "Stalled 4 days · 1 file" });
    await again.call("suggestion.answer", { suggestionId: s!.suggestionId, keep: true });
    const sent: string[] = [];
    const runs: string[] = [];
    await again.subscribe({ chatId }, (e) => {
      if (e.type === EV.messageSent) sent.push((e.data as { text: string }).text);
      if (e.type === EV.runStarted) runs.push((e.data as { harness: string }).harness);
    });
    await until(() => runs.length === 2, 10_000);
    expect(sent).toEqual(["edit", "Pick up where you left off."]);
    expect(runs).toEqual(["fake", "fake"]);
    expect(await again.call("suggestions.list", {})).toEqual([]);
  });
});
