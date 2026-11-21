import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type IonClient } from "@ion/client";
import { loadUserConfig } from "@ion/config";
import { afterEach, describe, expect, it } from "vitest";
import { memorySecrets } from "../secrets/index.js";
import { agentHome, pluginHome } from "../tools/import-testing.js";
import { startServer } from "./server.js";

// The user, 2026-11-21: "user would like to use the skills, mcp, or plugins that is already in the harness": each agent
// brings its own into ion's chats ("Use its own tools", on). Settings → Tools shows them read-only beside ion's.

let srv: Awaited<ReturnType<typeof startServer>>;
let client: IonClient;
let root: string;

async function start(config: string, withProject = false) {
  root = mkdtempSync(join(tmpdir(), "ion-own-api-"));
  const { home, project } = agentHome();
  pluginHome(home);
  if (withProject) config += `[[projects]]\nid = "shop"\npath = "${project}"\nstarred = false\n`;
  writeFileSync(join(root, "mcp.json"), JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
  writeFileSync(join(root, "config.toml"), config);
  mkdirSync(join(root, "data"));
  srv = await startServer({
    ...{ dataDir: join(root, "data"), configFile: join(root, "config.toml"), port: 0 },
    ...{ secrets: memorySecrets(), home },
  });
  client = await connect({ port: srv.port, token: srv.token });
  return project;
}

afterEach(async () => {
  client.close();
  await srv.close();
});

describe("each agent's own tools", () => {
  it("Settings → Tools lists an agent's own servers read-only", async () => {
    await start("[agents.codex]\nownTools = false\n");
    const t = await client.call("tools.list", {});
    expect(t.own.agents).toMatchObject({
      "claude-code": true,
      codex: false,
      opencode: true,
      "grok-build": true,
    });
    expect(t.own.servers).toContainEqual({
      agent: "claude-code",
      name: "github",
      transport: "stdio",
      launch: "gh-mcp serve",
      match: expect.any(String),
    });
    expect(t.own.plugins.map((p) => `${p.agent}:${p.name}`)).toContain("claude-code:superpowers");
    // No switch: it's the agent's.
    await expect(client.call("tools.setOn", { kind: "mcp", id: "github", on: true })).rejects.toThrow();
  });

  // Security review, 2026-11-21: a project's own .mcp.json is the repo's, not yours: listed with a switch, off until
  // you turn it on (consent to exactly what it runs).
  it("a repo's .mcp.json server is off until consented (its switch in Settings)", async () => {
    const project = await start("", true);
    const file = join(project, ".mcp.json");
    const c = JSON.parse(readFileSync(file, "utf8"));
    c.mcpServers.pkgtool = { type: "http", url: "https://mcp.acme.example/mcp" };
    writeFileSync(file, JSON.stringify(c));
    const repo = async (name: string) =>
      (await client.call("tools.list", {})).own.servers.find((s) => s.name === name)?.repo;
    expect(await repo("pkgtool")).toEqual({
      project: "shop",
      file: ".mcp.json",
      id: `${project}#pkgtool`,
      on: false,
      new: true,
    });
    await client.call("tools.setOn", { kind: "repo", id: `${project}#pkgtool`, on: true });
    expect(await repo("pkgtool")).toMatchObject({ on: true });
    expect(loadUserConfig(join(root, "config.toml")).config.tools.repoOn).toEqual([
      expect.stringMatching(/#pkgtool@/),
    ]);
    await client.call("tools.setOn", { kind: "repo", id: `${project}#pkgtool`, on: false });
    expect(await repo("pkgtool")).toMatchObject({ on: false, new: true });
    // Ruling, 2026-11-21: a repo's local one (any command) has no lasting switch; ion asks in each chat.
    expect(await repo("repotool")).toMatchObject({ asks: true, on: false });
    await expect(
      client.call("tools.setOn", { kind: "repo", id: `${project}#repotool`, on: true }),
    ).rejects.toThrow("It runs code from the repo: ion asks in each chat");
  });

  it("Use its own tools off brings back ion's tools only (the switch, in your config)", async () => {
    await start("");
    expect((await client.call("settings.get", {})).ownTools).toMatchObject({ codex: true, opencode: true });
    const s = await client.call("settings.set", { patch: { ownTools: { codex: false } } });
    expect(s.ownTools.codex).toBe(false);
    expect(loadUserConfig(join(root, "config.toml")).config.agents.codex?.ownTools).toBe(false);
    await expect(client.call("settings.set", { patch: { ownTools: { nope: false } } })).rejects.toThrow(
      "Unknown agent: nope",
    );
  });
});
