import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import { describe, expect, it } from "vitest";
import { agentHome } from "./import-testing.js";
import { repoKey, repoState, runOwnOf } from "./own-run.js";
import { repoMaterial, runsRepoCode } from "./own.js";

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

// Ruling (automated review, 2026-11-21): hashing a repo's code kept missing ways in (flag values, env, shell wrappers,
// links). A repo's local server keeps a lasting consent only when it provably runs a published package; anything else
// runs code from the repo, and ion asks in each chat that would start it ("Allow for this chat").
describe("a repo server that runs the repo's own code", () => {
  const sign = async (m: string) => createHash("sha256").update(m).digest("hex");

  it("counts only a package runner with a published package and nothing of the repo as not repo code", () => {
    const project = mkdtempSync(join(tmpdir(), "ion-repo-code-"));
    writeFileSync(join(project, "server.py"), "print(1)");
    const npx = { command: "npx", args: ["-y", "@scope/pkg"] };
    expect(runsRepoCode(project, npx)).toBe(false);
    expect(runsRepoCode(project, { command: "uvx", args: ["mcp-server-time"] })).toBe(false);
    expect(
      runsRepoCode(project, { command: "docker", args: ["run", "-i", "--rm", "ghcr.io/org/img:1"] }),
    ).toBe(false);
    for (const v of [
      { command: "node", args: ["./tools/mcp.js"] },
      { command: "python", args: ["server.py"] },
      { command: "npx", args: ["--prefix=./x", "pkg"] },
      { command: "npx", args: ["-y", "pkg"], env: { NODE_OPTIONS: "--require ./hook.js" } },
      { command: "npx", args: ["-y", "pkg"], env: { CONFIG: "server.py" } },
      { command: "sh", args: ["-c", "npx -y pkg"] },
      { command: "npx", args: ["-c", "node x"] },
      { command: "npx", args: ["-y", "src/local"] },
    ])
      expect(runsRepoCode(project, v), JSON.stringify(v)).toBe(true);
  });

  it("`node ./tools/mcp.js` asks in each chat; `npx -y @scope/pkg` keeps its mark", async () => {
    const { home, project } = agentHome();
    const local = { command: "node", args: ["./tools/mcp.js"] };
    const pkg = { command: "npx", args: ["-y", "@scope/pkg"] };
    writeFileSync(join(home, ".claude.json"), JSON.stringify({}));
    writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { local, pkg } }));
    const root = mkdtempSync(join(tmpdir(), "ion-own-run-"));
    const configFile = join(root, "config.toml");
    const record = `${repoKey(project, "pkg")}@${await sign(repoMaterial(project, "pkg", pkg))}`;
    const projects = [{ id: "shop", path: project, starred: false }];
    saveUserConfig(configFile, {
      ...DEFAULT_CONFIG,
      projects,
      tools: { ...DEFAULT_CONFIG.tools, repoOn: [record] },
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
    expect(await names("c1", "r1")).toEqual(["local", "pkg"]);
    expect(await names("c1", "r2")).toEqual(["local", "pkg"]);
    expect(asked).toEqual(["c1: shop's .mcp.json wants to run local from the repo"]);
    yes = false;
    expect(await names("c2", "r3")).toEqual(["pkg"]);
    expect(asked).toHaveLength(2);
    // With a repo-code server, a switch in Settings means nothing: there's no lasting mark to give it.
    expect(await repoState(sign, [])(project, "local", local)).toEqual({ on: false, new: true, asks: true });
  });
});
