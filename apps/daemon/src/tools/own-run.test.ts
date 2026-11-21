import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import { describe, expect, it } from "vitest";
import { agentHome } from "./import-testing.js";
import { repoState, runOwnOf } from "./own-run.js";
import { repoKey, repoMaterial } from "./own.js";

// Security review, 2026-11-21: `${VAR}` in an agent's own server is filled only from the environment an agent may
// have (ion's own variables, run keys and your keys left out), never ion's whole environment.
describe("a run's Claude Code servers", () => {
  it("${ION_RUN_KEY} (or any ION_*) in an own server's env stays unfilled; the server is left out", async () => {
    const { home, project } = agentHome();
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          leak: { command: "x-mcp", env: { K: "${ION_RUN_KEY}" } },
          other: { command: "y-mcp", env: { K: "${ION_SECRET_THING}" } },
          fine: { command: "z-mcp", env: { K: "${PLAIN}" } },
        },
      }),
    );
    const root = mkdtempSync(join(tmpdir(), "ion-own-run-"));
    const configFile = join(root, "config.toml");
    saveUserConfig(configFile, {
      ...DEFAULT_CONFIG,
      projects: [{ id: "shop", path: project, starred: false }],
    });
    const env = { ION_RUN_KEY: "run-key-0123456789", ION_SECRET_THING: "s3cret-0123456789", PLAIN: "ok" };
    const own = runOwnOf({ home, dataDir: join(root, "data"), configFile, env, sign: async (m) => m });
    const r = await own.forRun({ runId: "run_1", harness: "claude-code", projectId: "shop", cwd: project });
    expect(r.ownServers?.map((s) => s.name)).toEqual(["fine"]);
    expect(JSON.stringify(r)).not.toContain("run-key-0123456789");
    expect(JSON.stringify(r)).not.toContain("s3cret-0123456789");
  });
});

// Ruling, 2026-11-21 (automated review): hashing a repo's code, then exempting "package runners", kept missing ways in
// (node_modules/.bin, .npmrc, docker mounts, word splitting). Every local server a repo wrote asks in each chat that
// would start it ("Allow for this chat"); only a repo's remote server keeps a lasting switch.
describe("a repo's local servers ask in each chat", () => {
  const sign = async (m: string) => createHash("sha256").update(m).digest("hex");

  it("`npx -y @scope/pkg` from a repo asks per chat too; a remote one keeps its mark", async () => {
    const { home, project } = agentHome();
    const local = { command: "node", args: ["./tools/mcp.js"] };
    const pkg = { command: "npx", args: ["-y", "@scope/pkg"] };
    const remote = { type: "http", url: "https://mcp.example.com/mcp" };
    writeFileSync(join(home, ".claude.json"), JSON.stringify({}));
    writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { local, pkg, remote } }));
    const root = mkdtempSync(join(tmpdir(), "ion-own-run-"));
    const configFile = join(root, "config.toml");
    const marks = await Promise.all(
      [["pkg", pkg] as const, ["remote", remote] as const].map(
        async ([n, v]) => `${repoKey(project, n)}@${await sign(repoMaterial(project, n, v))}`,
      ),
    );
    const projects = [{ id: "shop", path: project, starred: false }];
    saveUserConfig(configFile, {
      ...DEFAULT_CONFIG,
      projects,
      tools: { ...DEFAULT_CONFIG.tools, repoOn: marks },
    });
    const asked: string[] = [];
    let yes = true;
    const ask = async (r: { chatId: string }, text: string) => {
      asked.push(`${r.chatId}: ${text}`);
      return yes;
    };
    const own = runOwnOf({ home, dataDir: join(root, "data"), configFile, env: {}, sign, ask });
    const run = (chatId: string, runId: string) =>
      own.forRun({ runId, chatId, harness: "claude-code", projectId: "shop", cwd: project });
    const names = async (chatId: string, runId: string) =>
      (await run(chatId, runId)).ownServers?.map((s) => s.name);
    expect(await names("c1", "r1")).toEqual(["local", "pkg", "remote"]);
    expect(await names("c1", "r2")).toEqual(["local", "pkg", "remote"]);
    expect(asked).toEqual([
      `c1: shop's .mcp.json wants to run "local" from the repo`,
      `c1: shop's .mcp.json wants to run "pkg" from the repo`,
    ]);
    yes = false;
    expect(await names("c2", "r3")).toEqual(["remote"]);
    expect(asked).toHaveLength(4);
    // Task review, 2026-11-21: a "No" is kept for the chat too (asked once), and both stay after ion restarts.
    expect(await names("c2", "r4")).toEqual(["remote"]);
    expect(asked).toHaveLength(4);
    const again = runOwnOf({ home, dataDir: join(root, "data"), configFile, env: {}, sign, ask });
    const after = async (chatId: string) =>
      (
        await again.forRun({ runId: "r9", chatId, harness: "claude-code", projectId: "shop", cwd: project })
      ).ownServers?.map((s) => s.name);
    expect(await after("c1")).toEqual(["local", "pkg", "remote"]);
    expect(await after("c2")).toEqual(["remote"]);
    expect(asked).toHaveLength(4);
    // A local one has no lasting switch to give it; a remote one does.
    expect(await repoState(sign, marks)(project, "pkg", pkg)).toEqual({ on: false, new: true, asks: true });
    expect(await repoState(sign, marks)(project, "remote", remote)).toEqual({ on: true });
  });
});
