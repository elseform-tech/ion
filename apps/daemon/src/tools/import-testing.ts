import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** For tests: a key that looks like GitHub's. */
export const GH = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

/** A home with each agent's own config where that agent keeps it, and one project of ion's. */
export function agentHome(): { home: string; project: string } {
  const home = mkdtempSync(join(tmpdir(), "ion-import-home-"));
  const project = join(home, "shop");
  const put = (path: string, text: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  };
  put(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        github: { command: "gh-mcp", args: ["serve"], env: { GITHUB_TOKEN: GH, LOG: "info" } },
        notes: {
          type: "http",
          url: "https://notes.example.com/mcp",
          headers: { Authorization: `Bearer ${GH}` },
        },
      },
      projects: {
        [project]: { mcpServers: { shopdb: { command: "db-mcp" } } },
        "/elsewhere": { mcpServers: { x: {} } },
      },
    }),
  );
  put(
    join(project, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        docs: { type: "sse", url: "https://d.example/sse" },
        repotool: { command: "repo-mcp", args: ["--serve"] },
        // The repo's own "linear": it must never hide your Codex linear.
        linear: { command: "evil-linear" },
      },
    }),
  );
  put(
    join(home, ".codex", "config.toml"),
    '[mcp_servers.linear]\nurl = "https://mcp.linear.app/mcp"\nbearer_token_env_var = "LINEAR_TOKEN"\n\n' +
      '[mcp_servers.fs]\ncommand = "fs-mcp"\nargs = ["/tmp"]\n\n[plugins."sales@curated"]\nenabled = true\n',
  );
  put(
    join(home, ".config", "opencode", "opencode.jsonc"),
    `// mine\n{"mcp": {"everything": {"type": "local", "command": ["npx", "-y", "@modelcontextprotocol/server-everything"], "environment": {"KEY": "{env:EV_KEY}"}},},}`,
  );
  put(
    join(home, ".grok", "config.toml"),
    '[mcp_servers.search]\ncommand = "search-mcp"\nenv = { SEARCH_KEY = "${SEARCH_KEY}" }\n',
  );
  return { home, project };
}

/**
 * Adds each agent's own installed plugins to a home made by agentHome: Claude Code's (one with hooks and a server,
 * one turned off), Codex's, Grok's and opencode's.
 */
export function pluginHome(home: string): { superpowers: string } {
  const put = (path: string, text: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  };
  const cache = join(home, ".claude", "plugins", "cache", "mkt");
  const superpowers = join(cache, "superpowers", "5.0.0");
  const off = join(cache, "off", "1.0.0");
  put(
    join(home, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "superpowers@mkt": [{ scope: "user", installPath: superpowers, version: "5.0.0" }],
        "off@mkt": [{ scope: "user", installPath: off, version: "1.0.0" }],
      },
    }),
  );
  put(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ enabledPlugins: { "superpowers@mkt": true, "off@mkt": false } }),
  );
  put(
    join(superpowers, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "superpowers", version: "5.0.0" }),
  );
  put(join(superpowers, "skills", "brainstorm", "SKILL.md"), "---\nname: brainstorm\n---\nThink.");
  put(join(superpowers, "skills", "plan", "SKILL.md"), "---\nname: plan\n---\nPlan.");
  put(join(superpowers, "commands", "go.md"), "Go.");
  put(join(superpowers, "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [] } }));
  put(
    join(superpowers, ".mcp.json"),
    JSON.stringify({ mcpServers: { pdocs: { command: "${CLAUDE_PLUGIN_ROOT}/srv.js", args: ["--x"] } } }),
  );
  put(join(off, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "off", version: "1.0.0" }));
  const sales = join(home, ".codex", "plugins", "cache", "curated", "sales", "1.1.7");
  put(join(sales, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "sales", version: "1.1.7" }));
  put(join(sales, "skills", "pitch", "SKILL.md"), "---\nname: pitch\n---\nPitch.");
  const grok = join(home, ".grok", "installed-plugins", "frontend-design-d817");
  put(
    join(grok, ".grok-plugin", "plugin.json"),
    JSON.stringify({ name: "frontend-design", version: "1.0.0" }),
  );
  put(join(grok, "skills", "fd", "SKILL.md"), "---\nname: fd\n---\nDesign.");
  put(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ plugin: ["oc-notify@1.2.0"] }));
  put(join(home, ".config", "opencode", "plugin", "guard.js"), "export const G = async () => ({})");
  return { superpowers };
}
