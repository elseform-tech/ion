import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StartOpts } from "@ion/adapter-kit";
import { addProject, DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import { afterEach, expect, it, vi } from "vitest";
import { createGrants } from "../mcp/index.js";
import { NeedsService } from "../needs/index.js";
import { EventStore, openDb } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { allViews } from "../views/index.js";
import { RunManager } from "./manager.js";

/** How the fake agent says it sandboxes (it starts no process: never by itself), and what each start was given. */
const fake = vi.hoisted(() => ({ how: undefined as "ion" | "own" | undefined, starts: [] as StartOpts[] }));
vi.mock("@ion/adapter-fake", async (real) => {
  const m = await real<typeof import("@ion/adapter-fake")>();
  return {
    ...m,
    createFakeAdapter: (...a: Parameters<typeof m.createFakeAdapter>) => {
      const adapter = m.createFakeAdapter(...a);
      if (fake.how) adapter.sandbox = fake.how;
      const start = adapter.start.bind(adapter);
      adapter.start = (opts) => {
        fake.starts.push(opts);
        return start(opts);
      };
      return adapter;
    },
  };
});
process.env.ION_ALLOW_FAKE = "1";
afterEach(() => {
  fake.how = undefined;
});

/** One run of "hello" on the fake agent with this run context: what the agent was started with, and its worktree. */
async function oneRun(more: object): Promise<{ opts: StartOpts; worktree: string | null; dataDir: string }> {
  const home = mkdtempSync(join(tmpdir(), "ion-run-sandbox-"));
  const repo = join(home, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const id = ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=T"];
  execFileSync("git", [...id, "commit", "-q", "--allow-empty", "-m", "init"]);
  const configFile = join(home, "config.toml");
  saveUserConfig(configFile, addProject(DEFAULT_CONFIG, repo));
  const db = openDb(":memory:");
  const store = new EventStore(db, allViews);
  const dataDir = join(home, "data");
  const runs = new RunManager(store, { configFile, dataDir, ...more }, new NeedsService(store, db), db);
  const { chatId, runId } = await runs.ask({ text: "hello", projectId: "repo", harness: "fake" });
  for (let i = 0; i < 300 && !store.read({ runId }).some((e) => e.type === "run.finished"); i++)
    await new Promise((r) => setTimeout(r, 10));
  return { opts: fake.starts.at(-1)!, worktree: chatsView.worktree(db, chatId), dataDir };
}

// The user, 2026-11-21: agents run in the OS sandbox, away from ion's own files. A chat's run on an agent that
// sandboxes is started in it (ion's folders denied, its worktree let through) with ion's port and its run key, so
// `ion` inside never needs daemon.json.
it("starts an agent that sandboxes in the run's sandbox, with ION_PORT", async () => {
  fake.how = "ion";
  const mcp = { grants: createGrants(), url: () => "http://127.0.0.1:4321/mcp" };
  const { opts, worktree, dataDir } = await oneRun({ sandbox: "seatbelt", port: () => 4321, mcp });
  expect(opts.sandbox?.kind).toBe("seatbelt");
  expect(opts.sandbox?.paths.deny).toContain(dataDir);
  expect(opts.sandbox?.paths.write).toEqual([worktree]);
  expect(opts.env).toMatchObject({ ION_PORT: "4321", ION_RUN_KEY: expect.any(String) });
});

it("starts no sandbox for an agent that starts no process, or on a computer without one", async () => {
  expect((await oneRun({ sandbox: "seatbelt" })).opts.sandbox).toBeUndefined();
  fake.how = "ion";
  expect((await oneRun({ sandbox: "none" })).opts.sandbox).toBeUndefined();
});
