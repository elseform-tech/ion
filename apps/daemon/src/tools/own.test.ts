import { existsSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentHome, GH, pluginHome } from "./import-testing.js";
import { claudeOwnForRun, ownToolsOf } from "./own.js";
import { readPlugins } from "./plugins.js";

// The user, 2026-11-21: "user would like to use the skills, mcp, or plugins that is already in the harness … Hooks
// probably should stay as these would need to be consistent." Reading is local: nothing is run, contacted or written
// in an agent's own folders.

const approve = (home: string, project: string, names: string[]) => {
  const file = join(home, ".claude.json");
  const c = JSON.parse(readFileSync(file, "utf8"));
  c.projects[project].enabledMcpjsonServers = names;
  writeFileSync(file, JSON.stringify(c));
};

describe("Claude Code's own tools, for a run", () => {
  it("Claude Code gets its own servers, skills and plugins, not its permission rules or hooks", async () => {
    const { home, project } = agentHome();
    const { superpowers } = pluginHome(home);
    approve(home, project, ["repotool"]);
    const before = readFileSync(join(home, ".claude.json"), "utf8");
    const dir = mkdtempSync(join(tmpdir(), "ion-own-run-"));
    const own = await claudeOwnForRun({ home, env: {}, project, dir });
    // Yours, this project's in ~/.claude.json, and the project's .mcp.json ones you approved in Claude Code; never SSE.
    expect(own.servers.map((s) => s.name)).toEqual(["github", "notes", "shopdb", "repotool", "pdocs"]);
    expect(own.servers[0]).toEqual({
      name: "github",
      transport: "stdio",
      command: "gh-mcp",
      args: ["serve"],
      env: { GITHUB_TOKEN: GH, LOG: "info" },
    });
    expect(own.servers.find((s) => s.name === "pdocs")).toMatchObject({ command: `${superpowers}/srv.js` });
    // Its keys are redacted from the run's events.
    expect(own.secrets).toContain(GH);
    // The plugin that bundles hooks comes as ion's copy without them; the one turned off doesn't come.
    expect(own.plugins).toHaveLength(1);
    const copy = own.plugins[0]!;
    expect(copy.startsWith(dir)).toBe(true);
    expect(existsSync(join(copy, "hooks"))).toBe(false);
    expect(readlinkSync(join(copy, "skills"))).toBe(join(superpowers, "skills"));
    expect(JSON.parse(readFileSync(join(copy, ".claude-plugin", "plugin.json"), "utf8"))).toEqual({
      name: "superpowers",
      version: "5.0.0",
    });
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe(before);
  });

  it("fills ${VAR} and ${VAR:-default} as Claude Code would, and leaves out a server whose variable is missing", async () => {
    const { home, project } = agentHome();
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          a: {
            type: "http",
            url: "https://a.example/${PATHX:-mcp}",
            headers: { Authorization: "Bearer ${A_TOKEN}" },
          },
          b: { command: "b", env: { K: "${NOPE}" } },
        },
      }),
    );
    const own = await claudeOwnForRun({
      home,
      env: { A_TOKEN: "tok-a" },
      project,
      dir: mkdtempSync(join(tmpdir(), "ion-own-")),
    });
    expect(own.servers).toEqual([
      {
        name: "a",
        transport: "http",
        url: "https://a.example/mcp",
        headers: { Authorization: "Bearer tok-a" },
      },
    ]);
    expect(own.secrets).toContain("Bearer tok-a");
  });
});

describe("Settings → Tools: each agent's own", () => {
  it("lists an agent's own servers read-only, for every agent, with whether its switch is on", () => {
    const { home, project } = agentHome();
    const own = ownToolsOf({ home, env: {}, projects: [project], agents: { codex: false } });
    expect(own.agents).toMatchObject({
      "claude-code": true,
      codex: false,
      opencode: true,
      "grok-build": true,
    });
    // Yours, never a repo's own file.
    expect(own.servers.map((s) => `${s.agent}:${s.name}`)).toEqual([
      "claude-code:github",
      "claude-code:notes",
      "claude-code:shopdb",
      "codex:linear",
      "codex:fs",
      "opencode:everything",
      "grok-build:search",
    ]);
    expect(own.servers.find((s) => s.name === "fs")).toEqual({
      agent: "codex",
      name: "fs",
      transport: "stdio",
      launch: "fs-mcp /tmp",
    });
    expect(own.servers.find((s) => s.name === "notes")?.launch).toBe("https://notes.example.com/mcp");
  });

  it("the Plugins tab lists each agent's plugins and what they bundle", () => {
    const { home, project } = agentHome();
    pluginHome(home);
    const plugins = readPlugins({ home, env: {}, projects: [project] }).map(
      ({ path: _p, servers: _s, ...p }) => p,
    );
    expect(plugins).toEqual([
      {
        agent: "claude-code",
        name: "superpowers",
        version: "5.0.0",
        bundles: { skills: 2, servers: 1, commands: 1, agents: 0 },
        hooks: "off",
      },
      {
        agent: "codex",
        name: "sales",
        version: "1.1.7",
        bundles: { skills: 1, servers: 0, commands: 0, agents: 0 },
      },
      {
        agent: "grok-build",
        name: "frontend-design",
        version: "1.0.0",
        bundles: { skills: 1, servers: 0, commands: 0, agents: 0 },
      },
      {
        agent: "opencode",
        name: "oc-notify",
        version: "1.2.0",
        bundles: { skills: 0, servers: 0, commands: 0, agents: 0 },
        hooks: "run",
      },
      {
        agent: "opencode",
        name: "guard",
        bundles: { skills: 0, servers: 0, commands: 0, agents: 0 },
        hooks: "run",
      },
    ]);
  });
});
