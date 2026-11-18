import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type FakeQueryCall, fakeQuery } from "../test/fake-query.js";
import { claudeGateCall, gateHooks } from "./gate.js";
import { createClaudeCodeAdapter, type Exec } from "./index.js";

/** A gate that answers with `answer` and keeps what it was sent. */
async function gate(answer: unknown) {
  const got: unknown[] = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      got.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const addr = srv.address();
  const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/gate/k`;
  return { url, got, close: () => srv.close() };
}

const pre = {
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "cat ~/.ssh/id_rsa" },
};
const signal = new AbortController().signal;
const run = (url: string) => gateHooks(url).PreToolUse[0]!.hooks[0]!(pre, "t1", { signal });

describe("Claude Code's gate hook", () => {
  it("reports every tool call to the gate and denies what ion denies", async () => {
    const g = await gate({ decision: "deny", reason: "Touches your secrets" });
    expect(await run(g.url)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Touches your secrets",
      },
    });
    expect(g.got).toEqual([{ tool_name: "Bash", tool_input: { command: "cat ~/.ssh/id_rsa" } }]);
    g.close();
  });

  it("lets an allowed call go on to Claude Code's own checks", async () => {
    const g = await gate({ decision: "allow" });
    expect(await run(g.url)).toEqual({});
    g.close();
  });

  it("denies when ion doesn't answer", async () => {
    expect(await run("http://127.0.0.1:1/gate/k")).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });

  it("is set on the session only when the run has a gate", async () => {
    const signedIn: Exec = async (_f, args) =>
      args[0] === "auth"
        ? { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) }
        : { code: 0, stdout: "2.1.326" };
    const calls: FakeQueryCall[] = [];
    const a = createClaudeCodeAdapter({
      exec: signedIn,
      which: () => "/bin/claude",
      query: fakeQuery(calls) as never,
    });
    const cwd = mkdtempSync(join(tmpdir(), "ion-cc-gate-"));
    const base = { cwd, model: null, effort: null, signal, decide: async () => "allow" as const };
    await a.start({ ...base, gate: { url: "http://127.0.0.1:1/gate/k" } });
    expect(calls.at(-1)?.options.hooks).toMatchObject({ PreToolUse: [{ hooks: [expect.any(Function)] }] });
    await a.start(base);
    expect(calls.at(-1)?.options.hooks).toBeUndefined();
    expect(a.gateCall?.({ tool_name: "mcp__github__search", tool_input: {} })).toMatchObject({
      kind: "mcp",
      mcpServer: "github",
    });
  });

  it("reads the hook's payload as a tool call", () => {
    expect(claudeGateCall({ tool_name: "Read", tool_input: { file_path: "/etc/hosts" } })).toMatchObject({
      toolName: "Read",
      kind: "read",
      input: { file_path: "/etc/hosts" },
    });
    expect(claudeGateCall({ tool_name: "Bash" })).toBeNull();
  });
});
