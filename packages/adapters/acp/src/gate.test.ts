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
  it("writes the hook in the worktree, keeps it out of git, and turns folder trust off for ion's run", () => {
    const { repo, wt } = worktree();
    const env = GROK_BUILD.env!({ url, cwd: wt });
    expect(JSON.parse(readFileSync(join(wt, ".grok/hooks/ion.json"), "utf8"))).toEqual({
      hooks: {
        PreToolUse: [{ hooks: [{ type: "http", url: "${ION_GATE_URL}", timeout: 60, failClosed: true }] }],
      },
    });
    expect(env).toMatchObject({ ION_GATE_URL: url, GROK_FOLDER_TRUST: "0" });
    GROK_BUILD.env!({ url, cwd: wt });
    const exclude = readFileSync(join(repo, ".git/info/exclude"), "utf8");
    expect(exclude.split("\n").filter((l) => l === "/.grok/hooks/ion.json")).toHaveLength(1);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: wt }).toString()).toBe("");
  });

  it("writes nothing without a gate", () => {
    const { wt } = worktree();
    expect(GROK_BUILD.env!()).not.toHaveProperty("ION_GATE_URL");
    expect(existsSync(join(wt, ".grok"))).toBe(false);
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
    expect(OPENCODE.toCall!({})).toBeNull();
  });
});
