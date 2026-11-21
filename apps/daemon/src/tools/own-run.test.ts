import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import { describe, expect, it } from "vitest";
import { agentHome } from "./import-testing.js";
import { runOwnOf } from "./own-run.js";

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
