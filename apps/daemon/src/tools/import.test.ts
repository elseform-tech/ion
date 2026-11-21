import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readAgentServers } from "./import.js";
import { agentHome, GH } from "./import-testing.js";

// The user, 2026-11-21: "Only ion's, plus Import": in ion's chats every agent uses only ion's servers, and Import
// brings yours in from each agent's own config. Reading is local: nothing is run or contacted.

describe("reading your agents' own MCP configs", () => {
  it("Import lists servers from each agent's config", () => {
    const { home, project } = agentHome();
    const r = readAgentServers({ home, env: {}, projects: [project] });
    const by = r.found.map((f) => `${f.agent}:${f.name}`);
    expect(by).toEqual([
      "claude-code:github",
      "claude-code:notes",
      "claude-code:shopdb",
      "claude-code:repotool",
      "claude-code:linear",
      "codex:linear",
      "codex:fs",
      "opencode:everything",
      "grok-build:search",
    ]);
    expect(r.found.find((f) => f.agent === "codex" && f.name === "linear")?.entry).toEqual({
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer ${LINEAR_TOKEN}" },
    });
    expect(r.found.find((f) => f.name === "everything")?.entry).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-everything"],
      env: { KEY: "${EV_KEY}" },
    });
    expect(r.found.find((f) => f.name === "search")).toMatchObject({
      from: "Grok Build",
      keys: ["SEARCH_KEY"],
    });
    // SSE isn't a way ion connects: said, not listed.
    expect(r.skipped).toEqual([
      { agent: "claude-code", name: "docs", why: "ion connects over HTTP, not SSE" },
    ]);
    expect(r.problems).toEqual([]);
  });

  // Security review, 2026-11-21: a project's own files were written by the repo, not you. Each server says where it
  // was found: yours (your agent's own config, or your ~/.claude.json for that project) or in a project's file.
  it("each server says whether it's yours or in a project's file, and which", () => {
    const { home, project } = agentHome();
    const r = readAgentServers({ home, env: {}, projects: [project] });
    expect(r.found.find((f) => f.name === "shopdb")?.repo).toBeUndefined();
    expect(r.found.find((f) => f.name === "repotool")).toMatchObject({
      repo: { project: "shop", file: ".mcp.json" },
    });
    expect(r.found.find((f) => f.name === "github")?.repo).toBeUndefined();
  });

  it("imported servers carry no literal secret: each becomes a ${NAME} to add a key for", () => {
    const { home } = agentHome();
    const r = readAgentServers({ home, env: {}, projects: [] });
    expect(JSON.stringify(r)).not.toContain(GH);
    expect(r.found.find((f) => f.name === "github")).toMatchObject({
      entry: { command: "gh-mcp", args: ["serve"], env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", LOG: "info" } },
      keys: ["GITHUB_TOKEN"],
    });
    expect(r.found.find((f) => f.name === "notes")).toMatchObject({
      entry: { headers: { Authorization: "Bearer ${NOTES_TOKEN}" } },
      keys: ["NOTES_TOKEN"],
    });
  });

  it("a file that can't be read is said in one line, and the others are still read", () => {
    const { home } = agentHome();
    writeFileSync(join(home, ".claude.json"), "{ not json");
    writeFileSync(join(home, ".grok", "config.toml"), `# ${"x".repeat(1024 * 1024)}`);
    const r = readAgentServers({ home, env: {}, projects: [] });
    expect(r.problems).toEqual(["ion couldn't read ~/.claude.json", "ion couldn't read ~/.grok/config.toml"]);
    expect(r.found.map((f) => f.name)).toEqual(["linear", "fs", "everything"]);
  });

  it("follows CODEX_HOME, GROK_HOME and XDG_CONFIG_HOME where they're set", () => {
    const { home } = agentHome();
    const other = mkdtempSync(join(tmpdir(), "ion-import-other-"));
    const r = readAgentServers({
      home,
      env: { CODEX_HOME: other, GROK_HOME: other, XDG_CONFIG_HOME: other },
      projects: [],
    });
    expect(r.found.map((f) => f.agent)).toEqual(["claude-code", "claude-code"]);
  });
});
