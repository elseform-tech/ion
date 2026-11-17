import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ApprovalRequest, ResumeFailed, type StartOpts } from "@ion/adapter-kit";
import { describeAdapterContract } from "@ion/adapter-kit/contract";
import { describe, expect, it } from "vitest";
import { type AcpHarness, createAcpAdapter } from "./index.js";

const AGENT = fileURLToPath(new URL("../test/fake-agent.mjs", import.meta.url));
const fake: AcpHarness = {
  id: "fake-acp",
  label: "Fake ACP",
  bin: process.execPath,
  args: [AGENT],
  versionArgs: ["--version"],
  loginArgs: [],
  loginHint: "fake login",
  defaultModel: null,
};
const cwd = mkdtempSync(join(tmpdir(), "ion-acp-"));
const make = () => createAcpAdapter(fake, { which: () => process.execPath });

describeAdapterContract("acp", make, { hello: "hello", approve: "approve", slow: "slow", cwd });

describe("acp adapter", () => {
  it("probes sign-in without sending a prompt", async () => {
    expect(await make().auth.status()).toEqual({ signedIn: true, method: "Signed in" });
    process.env.FAKE_ACP_SIGNED_OUT = "1";
    try {
      expect(await make().auth.status()).toEqual({ signedIn: false, method: "Not signed in" });
      await expect(
        make().start({
          cwd,
          model: null,
          effort: null,
          signal: new AbortController().signal,
          decide: async () => "allow",
        }),
      ).rejects.toThrow("Fake ACP isn't signed in. Run: fake login");
    } finally {
      delete process.env.FAKE_ACP_SIGNED_OUT;
    }
  });

  it("streams text in batches and reports the model and cost", async () => {
    const s = await make().start({
      cwd,
      model: null,
      effort: null,
      signal: new AbortController().signal,
      decide: async () => "allow",
    });
    await s.send({ text: "hello" });
    const events = [];
    for await (const e of s.events()) events.push(e);
    expect(events[0]).toMatchObject({
      type: "run.started",
      data: { harness: "fake-acp", model: "fake-1", sessionId: expect.any(String) },
    });
    expect(
      events
        .filter((e) => e.type === "message.delta")
        .map((e) => (e.data as { text: string }).text)
        .join(""),
    ).toBe("Hi there");
    expect(events.find((e) => e.type === "usage.reported")?.data).toMatchObject({ costUsd: 0.002 });
    expect(events.at(-1)).toEqual({ type: "run.finished", data: { status: "done" } });
  });

  it("reports not installed when the binary is missing", async () => {
    expect(await createAcpAdapter(fake, { which: () => null }).detect()).toEqual({ installed: false });
  });

  // Grok asks for an MCP tool as a "UseTool" call named <server>__<tool> (seen live, Plan 04).
  it("recognizes an MCP tool call and its server", async () => {
    const { answerPermission } = await import("./session.js");
    const seen: ApprovalRequest[] = [];
    const decide = async (r: ApprovalRequest) => {
      seen.push(r);
      return "allow" as const;
    };
    const ask = (rawInput: object, title = "x") =>
      answerPermission(
        {
          toolCall: { toolCallId: "t", title, kind: "other", rawInput },
          options: [{ optionId: "y", kind: "allow_once" }],
        },
        decide,
        () => {},
      );
    await ask(
      { variant: "UseTool", tool_name: "ion__search_chats", tool_input: { query: "kiwi" } },
      "ion__search_chats",
    );
    await ask({ variant: "UseTool", tool_name: "github__create_issue", tool_input: {} });
    await ask({ command: "ls" });
    expect(seen.map((r) => [r.kind, r.mcpServer, r.toolName])).toEqual([
      ["mcp", "ion", "ion__search_chats"],
      ["mcp", "github", "github__create_issue"],
      ["other", null, "other"],
    ]);
  });

  it("never widens a decision: allow without an allow_once option is refused", async () => {
    const { answerPermission } = await import("./session.js");
    const opts = (kinds: string[]) => ({
      toolCall: { toolCallId: "t" },
      options: kinds.map((k) => ({ optionId: k, kind: k })),
    });
    const emit = () => {};
    expect(await answerPermission(opts(["allow_always", "reject_once"]), async () => "allow", emit)).toEqual({
      outcome: { outcome: "cancelled" },
    });
    expect(
      await answerPermission(opts(["allow_once", "allow_always"]), async () => "allow_always", emit),
    ).toEqual({
      outcome: { outcome: "selected", optionId: "allow_always" },
    });
    expect(await answerPermission(opts(["allow_once"]), async () => "allow_always", emit)).toEqual({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
    expect(await answerPermission(opts(["reject_always", "allow_once"]), async () => "deny", emit)).toEqual({
      outcome: { outcome: "selected", optionId: "reject_always" },
    });
  });

  it("passes the agent's locations to the policy", async () => {
    const { answerPermission } = await import("./session.js");
    let seen: Record<string, unknown> = {};
    const p = {
      toolCall: {
        toolCallId: "t",
        kind: "edit",
        locations: [{ path: "/repo/a.ts" }],
        rawInput: { file_path: "/repo/a.ts" },
      },
      options: [],
    };
    await answerPermission(
      p,
      async (r) => {
        seen = r.input;
        return "deny";
      },
      () => {},
    );
    expect(seen).toEqual({ file_path: "/repo/a.ts", locations: ["/repo/a.ts"] });
  });

  it("tolerates malformed locations and refuses when deciding fails", async () => {
    const { answerPermission } = await import("./session.js");
    const p = {
      toolCall: { toolCallId: "t", kind: "edit", locations: [null, 3, { path: "/r/a" }] },
      options: [{ optionId: "y", kind: "allow_once" }],
    };
    let seen: Record<string, unknown> = {};
    await answerPermission(
      p,
      async (r) => {
        seen = r.input;
        return "allow";
      },
      () => {},
    );
    expect(seen.locations).toEqual(["/r/a"]);
    const failing = await answerPermission(
      p,
      async () => {
        throw new Error("boom");
      },
      () => {},
    );
    expect(failing).toEqual({ outcome: { outcome: "cancelled" } });
  });

  const turn = async (h: AcpHarness, text: string, extra: Partial<StartOpts> = {}) => {
    const s = await createAcpAdapter(h, { which: () => process.execPath }).start({
      cwd,
      model: null,
      effort: null,
      ...extra,
      signal: new AbortController().signal,
      decide: async () => "deny",
    });
    await s.send({ text });
    const events = [];
    for await (const e of s.events()) events.push(e);
    return events;
  };

  const resumed = async (resume: string, caps?: string) => {
    if (caps) process.env.FAKE_ACP_CAPS = caps;
    try {
      const s = await createAcpAdapter(fake, { which: () => process.execPath }).start({
        cwd,
        model: null,
        effort: null,
        resume,
        signal: new AbortController().signal,
        decide: async () => "deny",
      });
      await s.send({ text: "howopened" });
      const out: string[] = [];
      for await (const e of s.events())
        if (e.type === "message.delta") out.push((e.data as { text: string }).text);
      return out.join("");
    } finally {
      delete process.env.FAKE_ACP_CAPS;
    }
  };

  it("continues a session with session/resume, else session/load without replaying it as new", async () => {
    expect(await resumed("s-old")).toBe("s-old via session/resume");
    expect(await resumed("s-old", "load")).toBe("s-old via session/load");
  });

  it("says so when a session can't be continued", async () => {
    await expect(resumed("s-old", "none")).rejects.toBeInstanceOf(ResumeFailed);
    await expect(resumed("gone")).rejects.toBeInstanceOf(ResumeFailed);
  });

  it("lists the agent's own models from its model option", async () => {
    expect(await make().capabilities()).toMatchObject({
      models: [
        { id: "fake-1", label: "Fake One" },
        { id: "fake-2", label: "Fake Two" },
      ],
      defaultModel: "fake-1",
      modelsLive: true,
    });
  });

  it("gives the agent ion's MCP server", async () => {
    const mcp = {
      name: "ion" as const,
      url: "http://127.0.0.1:9/mcp",
      headers: { Authorization: "Bearer k" },
    };
    const events = await turn(fake, "whoami", { mcp });
    const said = events
      .filter((e) => e.type === "message.delta")
      .map((e) => (e.data as { text: string }).text)
      .join("");
    expect(JSON.parse(said).mcpServers).toEqual([
      {
        type: "http",
        name: "ion",
        url: "http://127.0.0.1:9/mcp",
        headers: [{ name: "Authorization", value: "Bearer k" }],
      },
    ]);
  });

  it("passes the harness's env and session options, and reads token usage", async () => {
    const h = { ...fake, env: () => ({ FAKE_ACP_ENV: "ask" }), sessionMeta: { yoloMode: false } };
    const events = await turn(h, "whoami");
    const said = events
      .filter((e) => e.type === "message.delta")
      .map((e) => (e.data as { text: string }).text)
      .join("");
    expect(JSON.parse(said)).toEqual({ meta: { yoloMode: false }, env: "ask", mcpServers: [] });
    expect(events.find((e) => e.type === "usage.reported")?.data).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
    });
  });

  it("treats the agent cancelling on its own (after a refusal) as done, not interrupted", async () => {
    expect((await turn(fake, "refuse")).at(-1)).toEqual({ type: "run.finished", data: { status: "done" } });
  });

  it("marks a crashed agent and a rate limit as retryable, other agent errors not", async () => {
    const errorOf = async (text: string) => (await turn(fake, text)).find((e) => e.type === "error")?.data;
    expect(await errorOf("crash")).toMatchObject({ code: "crash", retryable: true });
    expect(await errorOf("ratelimit")).toMatchObject({ code: "rate_limit", retryable: true });
    expect(await errorOf("badinput")).toMatchObject({ code: "agent", retryable: false });
  });

  // Regression (final review I5): an agent that never answers startup used to hang ion forever.
  it("gives up on an agent that never starts, and reports it", async () => {
    process.env.FAKE_ACP_HANG = "1";
    try {
      const a = createAcpAdapter(fake, { which: () => process.execPath, startTimeoutMs: 300 });
      await expect(
        a.start({
          cwd,
          model: null,
          effort: null,
          signal: new AbortController().signal,
          decide: async () => "allow",
        }),
      ).rejects.toThrow("Fake ACP didn't respond");
      expect(await a.auth.status()).toEqual({ signedIn: false, method: "Not responding" });
    } finally {
      delete process.env.FAKE_ACP_HANG;
    }
  });
});
