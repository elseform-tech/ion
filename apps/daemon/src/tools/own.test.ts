import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentHome, GH, pluginHome } from "./import-testing.js";
import { claudeOwnForRun, matchOf, ownToolsOf } from "./own.js";
import { readPlugins } from "./plugins.js";

// The user, 2026-11-21: "user would like to use the skills, mcp, or plugins that is already in the harness … Hooks
// probably should stay as these would need to be consistent." Reading is local: nothing is run, contacted or written
// in an agent's own folders.

/** A repo's own servers you turned on in ion (by name), whatever Claude Code's own approvals say. */
const consented = (names: string[]) => async (name: string) => names.includes(name);

describe("Claude Code's own tools, for a run", () => {
  it("Claude Code gets its own servers, skills and plugins, not its permission rules or hooks", async () => {
    const { home, project } = agentHome();
    const { superpowers } = pluginHome(home);
    const before = readFileSync(join(home, ".claude.json"), "utf8");
    const dir = mkdtempSync(join(tmpdir(), "ion-own-run-"));
    const own = await claudeOwnForRun({ home, env: {}, project, dir, repoOn: consented(["repotool"]) });
    // Yours, this project's in ~/.claude.json, and the project's .mcp.json ones you turned on in ion; never SSE.
    expect(own.servers.map((s) => s.name)).toEqual(["github", "notes", "shopdb", "repotool", "pdocs"]);
    expect(own.servers[0]).toEqual({
      name: "github",
      transport: "stdio",
      command: "gh-mcp",
      args: ["serve"],
      env: { GITHUB_TOKEN: GH, LOG: "info" },
    });
    expect(own.servers.find((s) => s.name === "pdocs")).toMatchObject({ command: `${superpowers}/srv.js` });
    // Its keys are redacted from the run's events: env and header values always, and anything filled from ${VAR}.
    expect(own.secrets).toContain(GH);
    expect(own.secrets).toContain(`Bearer ${GH}`);
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
      repoOn: consented([]),
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

// Security review, 2026-11-21: a repo's own .mcp.json is written by the repo, not you (Claude Code itself asks before
// using one). Its servers stay off until you turn each on in ion; Claude Code's own approvals don't count.
describe("a repo's own servers", () => {
  it("a repo's .mcp.json server is off until consented", async () => {
    const { home, project } = agentHome();
    const file = join(home, ".claude.json");
    const c = JSON.parse(readFileSync(file, "utf8"));
    c.projects[project].enableAllProjectMcpServers = true;
    writeFileSync(file, JSON.stringify(c));
    const dir = mkdtempSync(join(tmpdir(), "ion-own-"));
    const off = await claudeOwnForRun({ home, env: {}, project, dir, repoOn: consented([]) });
    expect(off.servers.map((s) => s.name)).not.toContain("repotool");
    const on = await claudeOwnForRun({ home, env: {}, project, dir, repoOn: consented(["repotool"]) });
    expect(on.servers.map((s) => s.name)).toContain("repotool");
  });
});

describe("Settings → Tools: each agent's own", () => {
  it("lists an agent's own servers read-only, for every agent, with whether its switch is on", async () => {
    const { home, project } = agentHome();
    const repo = async (_p: string, name: string) =>
      name === "repotool" ? { on: true } : { on: false, new: true as const };
    const own = await ownToolsOf({ home, env: {}, projects: [project], agents: { codex: false }, repo });
    expect(own.agents).toMatchObject({
      "claude-code": true,
      codex: false,
      opencode: true,
      "grok-build": true,
    });
    // Yours, then (security review, 2026-11-21) a repo's own .mcp.json for Claude Code, each with your switch.
    expect(own.servers.map((s) => `${s.agent}:${s.name}`)).toEqual([
      "claude-code:github",
      "claude-code:notes",
      "claude-code:shopdb",
      "codex:linear",
      "codex:fs",
      "opencode:everything",
      "grok-build:search",
      "claude-code:repotool",
      "claude-code:linear",
    ]);
    expect(own.servers.filter((s) => s.repo).map((s) => s.repo)).toEqual([
      { project: "shop", file: ".mcp.json", id: `${project}#repotool`, on: true },
      { project: "shop", file: ".mcp.json", id: `${project}#linear`, on: false, new: true },
    ]);
    expect(own.servers.find((s) => s.name === "fs")).toEqual({
      agent: "codex",
      name: "fs",
      transport: "stdio",
      launch: "fs-mcp /tmp",
      match: expect.stringMatching(/^[0-9a-f]{16}$/),
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

// Ruling, 2026-11-21: a repo's server name is shown in a question in the chat: one that breaks the name rule (1-40
// letters, digits, - and _) is left out with one plain line, never shown or run (held scan: not even cleaned).
describe("a repo's server with a bad name", () => {
  it("is left out with one plain line, its name never shown", async () => {
    const { home, project } = agentHome();
    writeFileSync(
      join(project, ".mcp.json"),
      JSON.stringify({ mcpServers: { "bad name\u0007!": { command: "x" }, ok: { command: "y" } } }),
    );
    const repo = async () => ({ on: false, new: true as const, asks: true as const });
    const own = await ownToolsOf({ home, env: {}, projects: [project], agents: {}, repo });
    expect(own.servers.filter((s) => s.repo).map((s) => s.name)).toEqual(["ok"]);
    expect(own.leftOut).toEqual([
      {
        name: "a server with an unusable name",
        why: "shop's .mcp.json: use up to 40 letters, digits, - or _",
      },
    ]);
    const dir = mkdtempSync(join(tmpdir(), "ion-own-"));
    const run = await claudeOwnForRun({ home, env: {}, project, dir, repoOn: async () => true });
    expect(run.servers.map((s) => s.name)).not.toContain("bad name\u0007!");
  });
});

// Task review, 2026-11-21: masking every value hid plain words in a chat (a path, a package name). A command, its args
// or a URL are masked only when they look like a key; env and header values, and anything filled from ${VAR}, always.
describe("what's masked of an agent's own server", () => {
  it("/opt/homebrew/bin/node and @playwright/mcp@latest aren't masked", async () => {
    const { home, project } = agentHome();
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          pw: { command: "/opt/homebrew/bin/node", args: ["@playwright/mcp@latest", "--token=${PW_TOKEN}"] },
          api: {
            type: "http",
            url: "https://api.example/mcp?key=sk-abcdef0123456789abcdef",
            headers: { X: "plain" },
          },
        },
      }),
    );
    const dir = mkdtempSync(join(tmpdir(), "ion-own-"));
    const own = await claudeOwnForRun({
      home,
      env: { PW_TOKEN: "pw-0123456789" },
      project,
      dir,
      repoOn: async () => false,
    });
    expect(own.secrets).not.toContain("/opt/homebrew/bin/node");
    expect(own.secrets).not.toContain("@playwright/mcp@latest");
    expect(own.secrets).toContain("--token=pw-0123456789");
    expect(own.secrets).toContain("https://api.example/mcp?key=sk-abcdef0123456789abcdef");
    expect(own.secrets).toContain("plain");
  });
});

// Task review, 2026-11-21 (and a held scan item): a repo's definition is never filled from your environment. One that
// asks for a ${NAME} is left out with one plain line; the row shows the whole URL as written, header and env names.
describe("a repo server never reads your environment", () => {
  it("one with ${NAME} is left out with a line; the row shows the full URL and names", async () => {
    const { home, project } = agentHome();
    writeFileSync(
      join(project, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          leaky: { type: "http", url: "https://x.example/mcp?k=${MY_TOKEN}" },
          team: { type: "http", url: "https://a.example/mcp?team=web", headers: { "X-Team": "web" } },
          tool: { command: "npx", args: ["-y", "pkg"], env: { MODE: "fast" } },
        },
      }),
    );
    const repo = async () => ({ on: false, new: true as const });
    const own = await ownToolsOf({ home, env: {}, projects: [project], agents: {}, repo });
    expect(own.leftOut).toEqual([
      { name: "leaky", why: "shop's .mcp.json: asks for MY_TOKEN from your environment" },
    ]);
    const rows = own.servers.filter((s) => s.repo);
    expect(rows.map((s) => [s.name, s.launch, s.repo?.headers, s.repo?.env])).toEqual([
      ["team", "https://a.example/mcp?team=web", ["X-Team"], undefined],
      ["tool", "npx -y pkg", undefined, ["MODE"]],
    ]);
    const dir = mkdtempSync(join(tmpdir(), "ion-own-"));
    const run = await claudeOwnForRun({
      home,
      env: { MY_TOKEN: "secret-0123456789" },
      project,
      dir,
      repoOn: async () => true,
    });
    expect(run.servers.map((s) => s.name)).not.toContain("leaky");
  });
});

// Task review, 2026-11-21: one row for "the same server" matched only what it runs; two setups with different env or
// header names, or a different URL query, are different. The match is a hash: no value reaches the app.
describe("matching a server across agents", () => {
  it("counts env names, header names and URL query names, never their values", () => {
    const a = matchOf({ command: "npx", args: ["-y", "x"], env: { TOKEN: "1" } });
    expect(matchOf({ command: "npx", args: ["-y", "x"], env: { TOKEN: "2" } })).toBe(a);
    expect(matchOf({ command: "npx", args: ["-y", "x"], env: { OTHER: "1" } })).not.toBe(a);
    const u = matchOf({ url: "https://a.example/mcp?team=web", headers: { X: "1" } });
    expect(matchOf({ url: "https://a.example/mcp?team=ops", headers: { X: "2" } })).toBe(u);
    expect(matchOf({ url: "https://a.example/mcp?org=web", headers: { X: "1" } })).not.toBe(u);
    expect(matchOf({ url: "https://a.example/mcp?team=web", headers: { Y: "1" } })).not.toBe(u);
    expect(a).not.toContain("npx");
  });
});

// Task review, 2026-11-21: a plugin's folder went into its servers by text replacement (a path with a quote broke the
// definition); ${CLAUDE_PLUGIN_DATA} was never filled; a skill's or subagent's own `hooks:` came along in ion's copy.
describe("Claude Code's plugins, as ion passes them", () => {
  it("fills its folder and data folder safely, and strips hooks from skills and subagents", async () => {
    const home = mkdtempSync(join(tmpdir(), "ion-plug-"));
    const project = join(home, "app");
    const root = join(home, 'we"ird', "kit", "1.0.0");
    const put = (p: string, t: string) => {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, t);
    };
    put(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "kit@m": [{ scope: "user", installPath: root, version: "1.0.0" }] },
      }),
    );
    put(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "kit@m": true } }));
    put(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "kit", version: "1.0.0" }));
    put(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          k: { command: "${CLAUDE_PLUGIN_ROOT}/srv.js", env: { DATA: "${CLAUDE_PLUGIN_DATA}" } },
        },
      }),
    );
    put(join(root, "skills", "s1", "SKILL.md"), "---\nname: s1\nhooks:\n  PreToolUse: []\n---\nDo.");
    put(join(root, "agents", "a1.md"), "---\nname: a1\nhooks: {}\n---\nAgent.");
    const dataDir = join(home, "data");
    const dir = join(dataDir, "skills", "r1", "own");
    const own = await claudeOwnForRun({
      home,
      env: {},
      project,
      dir,
      repoOn: async () => false,
      pluginData: join(dataDir, "plugin-data"),
    });
    expect(own.servers).toEqual([
      {
        name: "k",
        transport: "stdio",
        command: `${root}/srv.js`,
        args: [],
        env: { DATA: join(dataDir, "plugin-data", "kit") },
      },
    ]);
    const copy = own.plugins[0]!;
    expect(copy.startsWith(dir)).toBe(true);
    expect(readFileSync(join(copy, "skills", "s1", "SKILL.md"), "utf8")).not.toContain("hooks");
    expect(readFileSync(join(copy, "agents", "a1.md"), "utf8")).not.toContain("hooks");
    expect(readFileSync(join(copy, "skills", "s1", "SKILL.md"), "utf8")).toContain("Do.");
  });
});

// Task review, 2026-11-21: two agents' plugins with the same name and no version matched by name alone.
describe("a plugin with no version", () => {
  it("is matched by what's in it", () => {
    const home = mkdtempSync(join(tmpdir(), "ion-plug-"));
    const grok = (d: string, body: string) => {
      const root = join(home, ".grok", "installed-plugins", d);
      mkdirSync(join(root, ".grok-plugin"), { recursive: true });
      writeFileSync(join(root, ".grok-plugin", "plugin.json"), JSON.stringify({ name: "kit" }));
      mkdirSync(join(root, "skills", body), { recursive: true });
      writeFileSync(join(root, "skills", body, "SKILL.md"), body);
    };
    grok("a", "one");
    grok("b", "two");
    const [a, b] = readPlugins({ home, env: {}, projects: [] });
    expect(a?.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(a?.hash).not.toBe(b?.hash);
  });
});
