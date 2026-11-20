import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GROK_BUILD, OPENCODE } from "./harnesses.js";

const url = `http://127.0.0.1:1/gate/${"a".repeat(64)}`;

/** A repo with a chat worktree, like ion makes. */
function worktree(): { repo: string; wt: string } {
  const home = mkdtempSync(join(tmpdir(), "ion-acp-gate-"));
  const repo = join(home, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync(
    "git",
    ["-c", "user.email=t@e.x", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "i"],
    {
      cwd: repo,
    },
  );
  const wt = join(home, "wt");
  execFileSync("git", ["worktree", "add", "-q", "-b", "ion/x", wt], { cwd: repo });
  return { repo, wt };
}

describe("Grok's gate hook", () => {
  // Security review: folder trust stays on (a repo's own .grok hooks and MCP servers never load unasked), so
  // ion's hook lives in your Grok folder and does nothing unless ion started the run.
  it("writes one hook in your Grok folder, that only acts in ion's runs, and leaves the worktree alone", () => {
    const home = mkdtempSync(join(tmpdir(), "ion-grok-home-"));
    process.env.GROK_HOME = home;
    try {
      const { wt } = worktree();
      const env = GROK_BUILD.env!({ url, cwd: wt });
      expect(env.ION_GATE_URL).toBe(url);
      expect(env).not.toHaveProperty("GROK_FOLDER_TRUST");
      const hook = JSON.parse(readFileSync(join(home, "hooks/ion-gate.json"), "utf8"));
      const h = hook.hooks.PreToolUse[0].hooks[0];
      // ion may hold a call up to 4 minutes while it asks you; the hook waits a little longer.
      expect(h).toMatchObject({ type: "command", timeout: 300, failClosed: true });
      expect(h.command).toMatch(/^\[ -z "\$ION_GATE_URL" \] && exit 0;/);
      expect(existsSync(join(wt, ".grok"))).toBe(false);
      GROK_BUILD.env!({ url, cwd: wt });
      expect(execFileSync("git", ["status", "--porcelain"], { cwd: wt }).toString()).toBe("");
    } finally {
      delete process.env.GROK_HOME;
    }
  });

  it("writes nothing without a gate", () => {
    const home = mkdtempSync(join(tmpdir(), "ion-grok-home-"));
    process.env.GROK_HOME = home;
    try {
      expect(GROK_BUILD.env!()).not.toHaveProperty("ION_GATE_URL");
      expect(existsSync(join(home, "hooks"))).toBe(false);
    } finally {
      delete process.env.GROK_HOME;
    }
  });

  it("reads Grok's hook payload as a tool call", () => {
    const call = (toolName: string, toolInput: Record<string, unknown>, extra = {}) =>
      GROK_BUILD.toCall!({ toolName, toolInput, toolInputTruncated: false, ...extra });
    expect(call("run_terminal_command", { command: "cat x" })).toMatchObject({
      toolName: "run_terminal_command",
      kind: "command",
      summary: "cat x",
      input: { command: "cat x" },
    });
    // Whatever Grok calls the file, policy and rules see it as file_path.
    expect(call("read_file", { target_file: "~/.ssh/id_rsa" })).toMatchObject({
      kind: "read",
      input: { file_path: "~/.ssh/id_rsa" },
    });
    expect(call("search_replace", { file_path: "a.ts" })).toMatchObject({ kind: "edit" });
    expect(call("grep", { pattern: "x" })).toMatchObject({ kind: "search" });
    // Real run, 2026-11-19: Grok's lookup of its own tools went to the judge as "other" and was stopped.
    expect(call("search_tool", { query: "ion decisions ask" })).toMatchObject({ kind: "search" });
    expect(call("web_fetch", { url: "https://x" })).toMatchObject({ kind: "web" });
    expect(call("github__search", {})).toMatchObject({ kind: "mcp", mcpServer: "github" });
    // A cut-off input can hide the end of a command: ion can't read it, so it's denied.
    expect(call("run_terminal_command", { command: "x" }, { toolInputTruncated: true })).toBeNull();
    expect(GROK_BUILD.toCall!({ nope: 1 })).toBeNull();
  });
});

describe("opencode's gate plugin", () => {
  it("loads ion's plugin through ion's own config, with the gate URL", () => {
    const env = OPENCODE.env!({ url, cwd: "/x" });
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}");
    const plugin = String(config.plugin.at(-1));
    expect(plugin).toMatch(/^file:\/\/.*\/plugin\/ion-gate\.js$/);
    expect(existsSync(fileURLToPath(plugin))).toBe(true);
    expect(env.ION_GATE_URL).toBe(url);
    expect(JSON.parse(OPENCODE.env!().OPENCODE_CONFIG_CONTENT ?? "{}").plugin).toBeUndefined();
  });

  it("reads opencode's plugin payload as a tool call", () => {
    expect(OPENCODE.toCall!({ tool: "bash", args: { command: "ls" } })).toMatchObject({
      kind: "command",
      summary: "ls",
    });
    expect(OPENCODE.toCall!({ tool: "read", args: { filePath: "/etc/hosts" } })).toMatchObject({
      kind: "read",
      summary: "/etc/hosts",
    });
    expect(OPENCODE.toCall!({ tool: "edit", args: { filePath: "a" } })).toMatchObject({ kind: "edit" });
    expect(OPENCODE.toCall!({ tool: "github_search", args: {} })).toMatchObject({ kind: "other" });
    // Live check: opencode names ion's own MCP tools ion_<tool>; they're ion's, allowed by policy.
    expect(OPENCODE.toCall!({ tool: "ion_memory_list", args: {} })).toMatchObject({
      toolName: "ion__memory_list",
      kind: "mcp",
      mcpServer: "ion",
    });
    // Final review: only ion's exact tool names; a server called ion_memory isn't ion.
    expect(OPENCODE.toCall!({ tool: "ion_memory_write", args: {} })).toMatchObject({
      toolName: "ion__memory_write",
    });
    expect(OPENCODE.toCall!({ tool: "ion_memory_write_x", args: {} })).toMatchObject({ kind: "other" });
    expect(OPENCODE.toCall!({})).toBeNull();
  });
});
