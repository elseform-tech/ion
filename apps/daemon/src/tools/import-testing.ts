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
      '[mcp_servers.fs]\ncommand = "fs-mcp"\nargs = ["/tmp"]\n',
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
