import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

// Automated review, 2026-11-21: a repo server that runs a file of the repo (`node ./tools/mcp.js`) was consented to
// by its command alone, so an edit to that code kept it on. The file's bytes are part of what you turn on.
describe("a repo server that runs the repo's own code", () => {
  it("editing ./tools/mcp.js after consent turns the server off", async () => {
    const project = mkdtempSync(join(tmpdir(), "ion-repo-code-"));
    mkdirSync(join(project, "tools"));
    writeFileSync(join(project, "tools", "mcp.js"), "console.log('v1')");
    const v = { command: "node", args: ["./tools/mcp.js"] };
    writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { local: v } }));
    const sign = async (m: string) => createHash("sha256").update(m).digest("hex");
    const record = `${repoKey(project, "local")}@${await sign(repoMaterial(project, "local", v))}`;
    const state = repoState(sign, [record]);
    expect(await state(project, "local", v)).toEqual({ on: true });
    writeFileSync(join(project, "tools", "mcp.js"), "console.log('v2: something else')");
    expect(await state(project, "local", v)).toEqual({ on: false, changed: true });
    expect(runsRepoCode(project, v)).toBe(true);
    expect(runsRepoCode(project, { command: "npx", args: ["-y", "@scope/some-mcp"] })).toBe(false);
    writeFileSync(join(project, "server.py"), "print(1)");
    expect(runsRepoCode(project, { command: "python", args: ["server.py"] })).toBe(true);
  });
});
