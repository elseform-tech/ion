import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AdapterEvent, type ApprovalRequest, ResumeFailed, type StartOpts } from "@ion/adapter-kit";
import { describeAdapterContract } from "@ion/adapter-kit/contract";
import { afterEach, describe, expect, it } from "vitest";
import { hookCommand } from "./gate.js";
import { createCodexAdapter } from "./index.js";

const FAKE = fileURLToPath(new URL("../test/fake-app-server.mjs", import.meta.url));
const cwd = mkdtempSync(join(tmpdir(), "ion-codex-"));
const make = () => createCodexAdapter({ which: () => process.execPath, prefixArgs: [FAKE] });

describeAdapterContract("codex", make, { hello: "hello", approve: "approve", slow: "slow", cwd });

type Opts = Partial<StartOpts>;
async function turn(text: string, o: Opts = {}): Promise<AdapterEvent[]> {
  const s = await make().start({
    cwd,
    model: null,
    effort: null,
    signal: new AbortController().signal,
    decide: async () => "allow",
    ...o,
  });
  await s.send({ text });
  const events: AdapterEvent[] = [];
  for await (const e of s.events()) events.push(e);
  return events;
}
const said = (events: AdapterEvent[]) =>
  events
    .filter((e) => e.type === "message.completed")
    .map((e) => (e.data as { text: string }).text)
    .join("");
const whoami = async (o: Opts = {}) => JSON.parse(said(await turn("whoami", o)));

afterEach(() => {
  delete process.env.FAKE_CODEX_SIGNED_OUT;
  delete process.env.FAKE_CODEX_UNTRUSTED;
  delete process.env.FAKE_CODEX_LOG;
});

describe("codex adapter", () => {
  it("detects the binary and its version", async () => {
    expect(await make().detect()).toEqual({ installed: true, version: "9.9.9", path: process.execPath });
    expect(await createCodexAdapter({ which: () => null }).detect()).toEqual({ installed: false });
  });

  // `codex login status` answers by its exit code; ion keeps only how you signed in, never account details.
  it("tells signed in from signed out without account details", async () => {
    expect(await make().auth.status()).toEqual({ signedIn: true, method: "ChatGPT" });
    process.env.FAKE_CODEX_SIGNED_OUT = "1";
    expect(await make().auth.status()).toEqual({ signedIn: false, method: "Not signed in" });
    await expect(turn("hello")).rejects.toThrow("Codex isn't signed in. Run: codex login");
  });

  it("streams text and thinking, reports the model and tokens, and never the account", async () => {
    const events = await turn("hello");
    expect(events[0]).toEqual({
      type: "run.started",
      data: {
        harness: "codex",
        model: "fake-codex-1",
        effort: null,
        authMethod: "ChatGPT",
        sessionId: "thread-1",
      },
    });
    expect(events.filter((e) => e.type === "message.delta").map((e) => e.data)).toEqual([
      { text: "Hi there" },
    ]);
    expect(events.filter((e) => e.type === "thinking.delta").map((e) => e.data)).toEqual([
      { text: "thinking" },
    ]);
    expect(said(events)).toBe("Hi there");
    expect(events.find((e) => e.type === "usage.reported")?.data).toEqual({
      model: "fake-codex-1",
      inputTokens: 120,
      outputTokens: 8,
      costUsd: null,
    });
    expect(events.at(-1)).toEqual({ type: "run.finished", data: { status: "done" } });
    expect(JSON.stringify(events)).not.toContain("example.com");
  });

  it("lists Codex's own models, without hidden ones", async () => {
    const caps = await make().capabilities();
    expect(caps.models).toEqual([
      { id: "fake-codex-1", label: "Fake Codex 1" },
      { id: "fake-codex-mini", label: "Fake Codex Mini" },
    ]);
    expect(caps).toMatchObject({ defaultModel: "fake-codex-1", modelsLive: true, approvals: "interactive" });
  });

  // Codex must ask ion before every tool, whatever your own Codex config says, and nobody can answer its own UI.
  it("opens threads that ask before tools, routed to ion, with ion's instructions, model and effort", async () => {
    const {
      thread,
      turn: t,
      overrides,
    } = await whoami({
      model: "fake-codex-mini",
      effort: "max",
      instructions: "Ask with ion's ask tool.",
    });
    expect(thread).toMatchObject({
      cwd,
      model: "fake-codex-mini",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      developerInstructions: "Ask with ion's ask tool.",
    });
    expect(t).toMatchObject({ threadId: "thread-1", effort: "xhigh" });
    expect(overrides).toEqual(
      expect.arrayContaining(["features.memories=false", "features.default_mode_request_user_input=false"]),
    );
  });

  // The bearer key goes over stdin in the thread's config, never on the command line (other users' `ps`).
  it("gives Codex ion's MCP server with its header, off the command line", async () => {
    process.env.FAKE_CODEX_LOG = join(mkdtempSync(join(tmpdir(), "ion-codex-log-")), "argv");
    const mcp = {
      name: "ion" as const,
      url: "http://127.0.0.1:9/mcp/k",
      headers: { Authorization: "Bearer s3cret" },
    };
    const { thread } = await whoami({ mcp });
    expect(thread.config.mcp_servers).toEqual({
      ion: { url: mcp.url, http_headers: { Authorization: "Bearer s3cret" } },
    });
    expect(readFileSync(process.env.FAKE_CODEX_LOG, "utf8")).not.toContain("s3cret");
  });

  it("continues a thread, and says so when Codex can't", async () => {
    const { thread } = await whoami({ resume: "thread-7" });
    expect(thread).toMatchObject({ threadId: "thread-7", approvalPolicy: "untrusted" });
    await expect(turn("hello", { resume: "gone-1" })).rejects.toBeInstanceOf(ResumeFailed);
  });

  it("asks ion about commands, with the command as the model wrote it", async () => {
    const seen: ApprovalRequest[] = [];
    const decide = async (r: ApprovalRequest) => {
      seen.push(r);
      return "allow_always" as const;
    };
    const events = await turn("command", { decide });
    expect(seen[0]).toMatchObject({ toolId: "c1", toolName: "Bash", kind: "command", summary: "npm test" });
    expect(seen[0]!.input).toEqual({ command: "npm test", cwd });
    expect(events.find((e) => e.type === "approval.requested")?.data).toMatchObject({
      toolId: "c1",
      kind: "command",
    });
    expect(JSON.parse(said(events))).toEqual({ decision: "acceptForSession" });
  });

  it("asks ion about an edit by its files", async () => {
    const seen: ApprovalRequest[] = [];
    await turn("approve", {
      decide: async (r) => {
        seen.push(r);
        return "allow";
      },
    });
    const file = join(cwd, "notes.md");
    expect(seen[0]).toMatchObject({
      kind: "edit",
      toolName: "apply_patch",
      input: { file_path: file, locations: [file] },
    });
  });

  it("asks ion about MCP tools, and declines forms nobody can fill in", async () => {
    const seen: ApprovalRequest[] = [];
    const events = await turn("mcp", {
      decide: async (r) => {
        seen.push(r);
        return "allow";
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      toolId: "m1",
      toolName: "mcp__ion__search_chats",
      mcpServer: "ion",
      kind: "mcp",
      input: { query: "kiwi" },
    });
    expect(JSON.parse(said(events))).toEqual({
      tool: { action: "accept", content: null, _meta: null },
      form: { action: "decline", content: null, _meta: null },
    });
  });

  // Security review, 2026-11-19 (HIGH): an edit approval for files ion never saw went out as `file_path: ""`.
  it("declines an edit whose files it doesn't know, without asking", async () => {
    const seen: ApprovalRequest[] = [];
    const events = await turn("editunknown", {
      decide: async (r) => {
        seen.push(r);
        return "allow";
      },
    });
    expect(seen).toEqual([]);
    expect(JSON.parse(said(events))).toEqual({ decision: "decline" });
  });

  // Security review, 2026-11-19 (MEDIUM): the form was bound to the latest call on the same server, so an allow
  // could go to the wrong tool. Only one call in flight, for the tool the form names, can be asked about.
  it("asks about an MCP form only when it names exactly one call in flight", async () => {
    const asked = async (variant: string) => {
      const seen: ApprovalRequest[] = [];
      const events = await turn(`mcpform ${variant}`, {
        decide: async (r) => {
          seen.push(r);
          return "allow";
        },
      });
      return { seen, answer: JSON.parse(said(events)) };
    };
    const one = await asked("one");
    expect(one.seen.map((r) => [r.toolId, r.toolName])).toEqual([["m1", "mcp__ion__search_chats"]]);
    expect(one.answer.action).toBe("accept");
    for (const variant of ["two", "done", "other"]) {
      const r = await asked(variant);
      expect(r.seen).toEqual([]);
      expect(r.answer).toEqual({ action: "decline", content: null, _meta: null });
    }
  });

  it("refuses Codex's own question card: questions go through ion's ask tool", async () => {
    const answer = JSON.parse(said(await turn("ask")));
    expect(answer.error.message).toMatch(/ion's ask tool/);
  });

  it("denies when deciding fails (fail closed)", async () => {
    const events = await turn("command", {
      decide: async () => {
        throw new Error("daemon gone");
      },
    });
    expect(JSON.parse(said(events))).toEqual({ decision: "decline" });
  });

  it("reports a rate limit as worth retrying", async () => {
    const events = await turn("fail");
    expect(events.filter((e) => e.type === "error").map((e) => e.data)).toEqual([
      { code: "rate_limit", retryable: true, message: "Rate limit reached" },
    ]);
    expect(events.at(-1)).toEqual({ type: "run.finished", data: { status: "failed" } });
  });

  it("reports a crash", async () => {
    const events = await turn("crash");
    expect(events.find((e) => e.type === "error")?.data).toMatchObject({ code: "crash", retryable: true });
    expect(events.at(-1)).toEqual({ type: "run.finished", data: { status: "failed" } });
  });
});

describe("codex adapter with ion's gate", () => {
  const gate = { url: "http://127.0.0.1:9/gate/k" };

  // Codex runs a hook only once you've trusted its exact content. ion learns the hash of its own hook from
  // Codex (`hooks/list`) once, then passes the hook and its trust with -c: nothing in your Codex folder changes.
  it("gives Codex ion's hook, trusted, and the gate's address", async () => {
    process.env.FAKE_CODEX_LOG = join(mkdtempSync(join(tmpdir(), "ion-codex-log-")), "argv");
    const { overrides, gate: url } = await whoami({ gate });
    expect(url).toBe(gate.url);
    expect(overrides.find((o: string) => o.startsWith("hooks.PreToolUse="))).toContain(
      JSON.stringify(hookCommand()),
    );
    expect(overrides.some((o: string) => o.startsWith("hooks.state="))).toBe(true);
    await whoami({ gate });
    // Later runs reuse what ion learned: one start each.
    const starts = readFileSync(process.env.FAKE_CODEX_LOG, "utf8").trim().split("\n");
    expect(starts.length).toBeLessThanOrEqual(3);
  });

  // Security review, 2026-11-19 (MEDIUM): Codex's commands inherited ION_GATE_URL (gate key included; seen live
  // with `printenv`). Only ion's hook needs it: the commands Codex runs get it blanked.
  it("keeps the gate's address from the commands Codex runs", async () => {
    const { overrides } = await whoami({ gate });
    expect(overrides).toContain('shell_environment_policy.set.ION_GATE_URL=""');
  });

  it("won't run Codex without its gate (fail closed)", async () => {
    process.env.FAKE_CODEX_UNTRUSTED = "1";
    await expect(turn("hello", { gate })).rejects.toThrow("Codex didn't accept ion's gate");
  });

  it("reads Codex's hook payload as a gate call", () => {
    expect(make().gateCall?.({ tool_name: "Bash", tool_input: { command: "ls" } })).toMatchObject({
      kind: "command",
      summary: "ls",
    });
  });
});
