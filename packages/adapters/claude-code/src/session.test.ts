import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeAdapterContract } from "@ion/adapter-kit/contract";
import { describe, expect, it } from "vitest";
import { type FakeQueryCall, fakeQuery } from "../test/fake-query.js";
import { createClaudeCodeAdapter, type Exec } from "./index.js";

const signedIn: Exec = async (_f, args) =>
  args[0] === "auth"
    ? { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) }
    : { code: 0, stdout: "2.1.326" };

const cwd = mkdtempSync(join(tmpdir(), "ion-cc-"));
const make = (calls?: FakeQueryCall[], exec: Exec = signedIn) =>
  createClaudeCodeAdapter({ exec, which: () => "/bin/claude", query: fakeQuery(calls) as never });

describeAdapterContract("claude-code", () => make(), {
  hello: "hello",
  approve: "approve",
  slow: "slow",
  cwd,
});

async function run(text: string, opts: { calls?: FakeQueryCall[]; exec?: Exec } = {}) {
  const session = await make(opts.calls, opts.exec).start({
    cwd,
    model: "haiku",
    effort: "low",
    signal: new AbortController().signal,
    decide: async () => "allow",
  });
  await session.send({ text });
  const events = [];
  for await (const e of session.events()) events.push(e);
  return { events, session };
}

describe("claude-code session", () => {
  it("loads only your user settings, and passes the project's CLAUDE.md as instructions", async () => {
    const calls: FakeQueryCall[] = [];
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(cwd, "CLAUDE.md"), "Use tabs.");
    await run("hello", { calls });
    const o = calls[0]!.options as { settingSources: string[]; systemPrompt: { append?: string } };
    expect(o.settingSources).toEqual(["user"]);
    expect(o.systemPrompt.append).toContain("Use tabs.");
  });

  it("never passes Claude's suggested permission rules through on allow always", async () => {
    const calls: FakeQueryCall[] = [];
    const session = await make(calls).start({
      cwd,
      model: null,
      effort: null,
      signal: new AbortController().signal,
      decide: async () => "allow_always",
    });
    await session.send({ text: "approve" });
    const seen = [];
    for await (const e of session.events()) seen.push(e);
    expect(seen.at(-1)?.type).toBe("run.finished");
    expect(calls[0]!.permissionResults).toEqual([{ behavior: "allow", updatedInput: expect.any(Object) }]);
  });

  it("passes safe options to the SDK", async () => {
    const calls: FakeQueryCall[] = [];
    process.env.ANTHROPIC_API_KEY = "sk-test";
    await run("hello", { calls });
    delete process.env.ANTHROPIC_API_KEY;
    const o = calls[0]!.options as Record<string, unknown> & { env: NodeJS.ProcessEnv };
    expect(o.env.PATH).toBeDefined();
    expect(o.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(o.permissionMode).not.toBe("bypassPermissions");
    expect(o).toMatchObject({
      cwd,
      model: "haiku",
      effort: "low",
      includePartialMessages: true,
      pathToClaudeCodeExecutable: "/bin/claude",
    });
  });

  it("records the native session id for resume", async () => {
    const { session } = await run("hello");
    expect(session.nativeId).toBe("native-1");
  });

  it("reports a crash as an error and a failed run", async () => {
    const { events } = await run("crash");
    expect(events.slice(-2).map((e) => e.type)).toEqual(["error", "run.finished"]);
    expect(events.at(-1)?.data).toEqual({ status: "failed" });
  });

  it("refuses to start when not signed in with the Claude login", async () => {
    const apiKeyOnly: Exec = async () => ({
      code: 0,
      stdout: JSON.stringify({ loggedIn: true, authMethod: "api_key" }),
    });
    await expect(run("hello", { exec: apiKeyOnly })).rejects.toThrow(
      "Claude Code isn't signed in. Run: claude auth login",
    );
  });
});
