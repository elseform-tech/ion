import { describe, expect, it } from "vitest";
import { type Exec, createClaudeCodeAdapter } from "./index.js";

const execWith =
  (
    outputs: Record<string, { code: number; stdout: string }>,
    seen: { env?: NodeJS.ProcessEnv }[] = [],
  ): Exec =>
  async (_file, args, opts) => {
    seen.push({ env: opts?.env });
    return outputs[args.join(" ")] ?? { code: 1, stdout: "" };
  };

const authJson = (loggedIn: boolean, authMethod: string) =>
  JSON.stringify({ loggedIn, authMethod, email: "someone@example.com", orgId: "o", orgName: "Org" });

describe("claude-code detect", () => {
  it("reads the version of the real binary on PATH", async () => {
    const a = createClaudeCodeAdapter({
      which: () => "/opt/homebrew/bin/claude",
      exec: execWith({ "--version": { code: 0, stdout: "2.1.326 (Claude Code)\n" } }),
    });
    expect(await a.detect()).toEqual({
      installed: true,
      version: "2.1.326",
      path: "/opt/homebrew/bin/claude",
    });
  });
  it("reports not installed when there's no binary", async () => {
    const a = createClaudeCodeAdapter({ which: () => null, exec: execWith({}) });
    expect(await a.detect()).toEqual({ installed: false });
  });
});

describe("claude-code auth", () => {
  const status = (out: { code: number; stdout: string }, seen?: { env?: NodeJS.ProcessEnv }[]) =>
    createClaudeCodeAdapter({
      which: () => "/bin/claude",
      exec: execWith({ "auth status --json": out }, seen),
    }).auth.status();

  it("is signed in with the Claude subscription login", async () => {
    expect(await status({ code: 0, stdout: authJson(true, "claude.ai") })).toEqual({
      signedIn: true,
      method: "Claude subscription",
    });
  });
  it("accepts a long-lived Claude token", async () => {
    expect(await status({ code: 0, stdout: authJson(true, "oauth_token") })).toEqual({
      signedIn: true,
      method: "Long-lived token",
    });
  });
  it("doesn't count an API key as signed in", async () => {
    expect(await status({ code: 0, stdout: authJson(true, "api_key") })).toEqual({
      signedIn: false,
      method: "API key",
    });
  });
  it("never returns account details", async () => {
    const r = await status({ code: 0, stdout: authJson(true, "claude.ai") });
    expect(Object.keys(r).sort()).toEqual(["method", "signedIn"]);
  });
  it("is signed out on a non-zero exit or bad output", async () => {
    expect((await status({ code: 1, stdout: authJson(false, "none") })).signedIn).toBe(false);
    expect((await status({ code: 0, stdout: "not json" })).signedIn).toBe(false);
  });
  it("checks without API keys in the environment", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.ANTHROPIC_AUTH_TOKEN = "tok";
    const seen: { env?: NodeJS.ProcessEnv }[] = [];
    await status({ code: 0, stdout: authJson(true, "claude.ai") }, seen);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    expect(seen[0]?.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen[0]?.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(seen[0]?.env?.PATH).toBeDefined();
  });
});

describe("claude-code capabilities", () => {
  it("lists effort levels and approvals", async () => {
    const c = await createClaudeCodeAdapter({ which: () => null, exec: execWith({}) }).capabilities();
    expect(c.effort.levels).toEqual(["low", "medium", "high", "max"]);
    expect(c.approvals).toBe("interactive");
    expect(c.models.map((m) => m.id)).toEqual(["opus", "sonnet", "haiku"]);
  });
});

describe("loginOnlyEnv", () => {
  // Security review: another run's MCP key never reaches Claude Code through an inherited environment.
  it("drops ion MCP header variables it inherited", async () => {
    const { loginOnlyEnv } = await import("./cli.js");
    expect(loginOnlyEnv({ ION_MCP_H0: "Bearer old", ION_MCP_H1: "x", PATH: "/bin" })).toEqual({
      PATH: "/bin",
    });
  });

  it("removes every variable that would bypass the Claude login, and keeps the rest", async () => {
    const { loginOnlyEnv } = await import("./cli.js");
    const env = loginOnlyEnv({
      PATH: "/bin",
      HOME: "/h",
      ANTHROPIC_API_KEY: "k",
      ANTHROPIC_AUTH_TOKEN: "t",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h" });
  });
});
