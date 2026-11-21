import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type IonClient } from "@ion/client";
import { loadUserConfig } from "@ion/config";
import { afterEach, describe, expect, it } from "vitest";
import { KeychainError, memorySecrets, type Secrets } from "../secrets/index.js";
import { startServer } from "./server.js";

// The user, 2026-11-20: Skills are "the skills your agents already have", on or off (T3 Code's way: Claude Code gets
// them through the Agent SDK's plugins). A skill is off until you turn it on in the app.

let root: string;
let srv: Awaited<ReturnType<typeof startServer>>;
let client: IonClient;

async function start(secrets: Secrets = memorySecrets()) {
  root = mkdtempSync(join(tmpdir(), "ion-skills-api-"));
  const home = join(root, "home");
  for (const [dir, name] of [
    [".claude/skills/pdf", "pdf"],
    [".codex/skills/deploy", "deploy"],
  ] as const) {
    mkdirSync(join(home, dir), { recursive: true });
    writeFileSync(join(home, dir, "SKILL.md"), `---\nname: ${name}\ndescription: Does ${name}\n---\nBody\n`);
  }
  writeFileSync(join(root, "mcp.json"), JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
  writeFileSync(join(root, "config.toml"), "");
  srv = await startServer({
    ...{ dataDir: join(root, "data"), configFile: join(root, "config.toml"), port: 0 },
    ...{ secrets, home },
  });
  client = await connect({ port: srv.port, token: srv.token });
}

afterEach(async () => {
  client.close();
  await srv.close();
});

describe("skills in Settings → Tools", () => {
  it("lists your agents' skills, turns Claude Code's on, and says the others use their own", async () => {
    await start();
    const t = await client.call("tools.list", {});
    expect(t.skills.map((s) => [s.name, s.whose, s.where, s.on]).sort()).toEqual([
      ["deploy", "codex", "~/.codex/skills/deploy", false],
      ["pdf", "claude", "~/.claude/skills/pdf", false],
    ]);
    expect(t.skills.find((s) => s.name === "pdf")?.support["claude-code"]).toBe("ion");
    expect(t.skills.find((s) => s.name === "deploy")?.support).toEqual({ codex: "own" });
    const after = await client.call("tools.setOn", { kind: "skill", id: "~/.claude/skills/pdf", on: true });
    expect(after.skills.find((s) => s.name === "pdf")?.on).toBe(true);
    const { config } = loadUserConfig(join(root, "config.toml"));
    expect(config.tools.skills.on).toEqual([
      expect.stringMatching(/^~\/\.claude\/skills\/pdf@[0-9a-f]{32}$/),
    ]);
    await expect(
      client.call("tools.setOn", { kind: "skill", id: "~/.codex/skills/deploy", on: true }),
    ).rejects.toThrow(/^Codex uses its own$/);
    const off = await client.call("tools.setOn", { kind: "skill", id: "~/.claude/skills/pdf", on: false });
    expect(off.skills.find((s) => s.name === "pdf")?.on).toBe(false);
  });

  it("turning a skill on with a locked keychain says so plainly", async () => {
    const locked: Secrets = {
      get: () => Promise.reject(new KeychainError("Your keychain is locked")),
      set: () => Promise.reject(new KeychainError("Your keychain is locked")),
      remove: async () => {},
    };
    await start(locked);
    await expect(
      client.call("tools.setOn", { kind: "skill", id: "~/.claude/skills/pdf", on: true }),
    ).rejects.toThrow(/^ion can't read your keychain$/);
  });
});
