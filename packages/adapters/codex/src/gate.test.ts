import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codexGateCall, GATE_HOOK, hookArgs, hookCommand, patchFiles, unwrapShell } from "./gate.js";

describe("Codex's hook payload as a gate call", () => {
  // Seen live (codex-cli 0.153.2): {tool_name: "Bash", tool_input: {command}, cwd, …}, Claude Code's shape.
  it("reads a shell command", () => {
    expect(codexGateCall({ tool_name: "Bash", tool_input: { command: "cat notes.txt" }, cwd: "/w" })).toEqual(
      {
        toolName: "Bash",
        kind: "command",
        summary: "cat notes.txt",
        input: { command: "cat notes.txt" },
      },
    );
  });

  // An edit is an apply_patch whose input is the patch: ion's policy needs the files it touches as paths.
  it("reads an edit's files from its patch, relative ones against the run's folder", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      "+x",
      "*** Add File: /w/b.ts",
      "+y",
      "*** Update File: c.ts",
      "*** Move to: ../outside.ts",
      "*** End Patch",
    ].join("\n");
    const call = codexGateCall({ tool_name: "apply_patch", tool_input: { command: patch }, cwd: "/w" });
    expect(call).toMatchObject({
      toolName: "apply_patch",
      kind: "edit",
      summary: "/w/src/a.ts",
      input: { file_path: "/w/src/a.ts", locations: ["/w/src/a.ts", "/w/b.ts", "/w/c.ts", "/outside.ts"] },
    });
    // No `command` left: a gate allow is matched to the prompt that follows by its file, not by the patch text.
    expect(call?.input).not.toHaveProperty("command");
    expect(call?.input.patch).toBe(patch);
  });

  // Security review, 2026-11-19 (HIGH): a patch ion couldn't read fell back to the run's folder as its file,
  // which ion's policy reads as an edit inside the worktree and allows. An edit that names no file must ask.
  it("never makes up a file for a patch it can't read", () => {
    for (const tool_input of [{}, { command: "" }, { command: "*** Begin Patch\n*** End Patch" }]) {
      const call = codexGateCall({ tool_name: "apply_patch", tool_input, cwd: "/w" });
      expect(call?.kind).toBe("edit");
      expect(call?.input).not.toHaveProperty("file_path");
      expect(call?.input).not.toHaveProperty("locations");
      expect(JSON.stringify(call?.input)).not.toContain('"/w"');
      expect(call?.summary).toBe("apply_patch");
    }
  });

  it("knows MCP tools and their server", () => {
    const ion = codexGateCall({ tool_name: "mcp__ion__search_chats", tool_input: { query: "kiwi" } });
    expect(ion).toMatchObject({ kind: "mcp", mcpServer: "ion", toolName: "mcp__ion__search_chats" });
    const gh = codexGateCall({ tool_name: "mcp__github__create_issue", tool_input: {} });
    expect(gh).toMatchObject({ kind: "mcp", mcpServer: "github" });
  });

  it("names other tools by kind where it can", () => {
    expect(codexGateCall({ tool_name: "web_search", tool_input: { query: "q" } })?.kind).toBe("web");
    expect(codexGateCall({ tool_name: "view_image", tool_input: { path: "/w/a.png" } })).toMatchObject({
      kind: "read",
      input: { file_path: "/w/a.png" },
    });
    expect(codexGateCall({ tool_name: "something_new", tool_input: {} })?.kind).toBe("other");
  });

  it("refuses what isn't a tool call", () => {
    expect(codexGateCall(null)).toBeNull();
    expect(codexGateCall({ tool_name: "Bash" })).toBeNull();
    expect(codexGateCall({ tool_input: {} })).toBeNull();
  });
});

describe("shell commands and patches", () => {
  it("unwraps the shell Codex runs a command in", () => {
    expect(unwrapShell("/bin/zsh -lc 'cat notes.txt'")).toBe("cat notes.txt");
    expect(unwrapShell("/bin/bash -lc 'echo '\\''hi'\\'''")).toBe("echo 'hi'");
    expect(unwrapShell("ls -la")).toBe("ls -la");
  });

  it("lists a patch's files once each", () => {
    expect(patchFiles("*** Update File: a\n*** Update File: a\n*** Delete File: b", "/w")).toEqual([
      "/w/a",
      "/w/b",
    ]);
  });
});

describe("the hook ion gives Codex", () => {
  it("runs ion's hook script with this Node, for every tool, and waits for ion up to 5 minutes", () => {
    const args = hookArgs(null);
    expect(args).toHaveLength(2);
    expect(args[0]).toBe("-c");
    expect(args[1]).toBe(
      `hooks.PreToolUse=[{matcher="*",hooks=[{type="command",command=${JSON.stringify(hookCommand())},timeout=300}]}]`,
    );
    expect(hookCommand()).toBe(`'${process.execPath}' '${GATE_HOOK}'`);
  });

  // Codex runs a hook only once its exact content is trusted: ion trusts its own, for its own runs only.
  it("trusts exactly ion's hook when it knows its hash", () => {
    const args = hookArgs({ key: "/<session-flags>/config.toml:pre_tool_use:0:0", hash: "sha256:ab" });
    expect(args.slice(2)).toEqual([
      "-c",
      'hooks.state={"/<session-flags>/config.toml:pre_tool_use:0:0"={trusted_hash="sha256:ab"}}',
    ]);
  });

  it("quotes paths with spaces and quotes for the shell", () => {
    expect(hookCommand("/a b/node", "/it's/hook.mjs")).toBe(`'/a b/node' '/it'\\''s/hook.mjs'`);
  });
});

describe("ion's hook script", () => {
  let server: Server;
  let url = "";
  const seen: unknown[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const p = JSON.parse(body) as { tool_input?: { command?: string } };
        seen.push(p);
        const deny = p.tool_input?.command?.includes("secret");
        res.end(JSON.stringify(deny ? { decision: "deny", reason: "Not that file" } : { decision: "allow" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/gate/k`;
  });
  afterAll(() => server.close());

  const run = (payload: object, env: Record<string, string>) =>
    new Promise<string>((resolve) => {
      const child = execFile(
        process.execPath,
        [GATE_HOOK],
        { env: { PATH: process.env.PATH, ...env } },
        (_e, out) => resolve(String(out)),
      );
      child.stdin?.end(JSON.stringify(payload));
    });
  const denied = (out: string) => JSON.parse(out).hookSpecificOutput;

  it("sends the call to ion and says nothing when ion allows it", async () => {
    const out = await run(
      { tool_name: "Bash", tool_input: { command: "ls" }, cwd: "/w", session_id: "s" },
      { ION_GATE_URL: url },
    );
    expect(out).toBe("");
    expect(seen.at(-1)).toEqual({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: "/w" });
  });

  it("denies with ion's reason", async () => {
    const out = await run(
      { tool_name: "Bash", tool_input: { command: "cat secret" } },
      { ION_GATE_URL: url },
    );
    expect(denied(out)).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Not that file",
    });
  });

  it("fails closed: no ion, or no gate address, blocks the call", async () => {
    const down = await run(
      { tool_name: "Bash", tool_input: { command: "ls" } },
      { ION_GATE_URL: "http://127.0.0.1:1/gate/k" },
    );
    expect(denied(down).permissionDecision).toBe("deny");
    const none = await run({ tool_name: "Bash", tool_input: { command: "ls" } }, {});
    expect(denied(none).permissionDecision).toBe("deny");
  });
});
