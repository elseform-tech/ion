import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AdapterEvent,
  type ApprovalRequest,
  type HttpMcpSpec,
  ResumeFailed,
  type StartOpts,
} from "@ion/adapter-kit";
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
  delete process.env.FAKE_CODEX_OWN_MCP;
  delete process.env.FAKE_CODEX_OWN_HOOK;
  delete process.env.FAKE_CODEX_NO_CONFIG_READ;
  delete process.env.FAKE_CODEX_MCP_SERVER;
  delete process.env.FAKE_CODEX_NO_LIMITS;
});

describe("codex adapter", () => {
  it("detects the binary and its version", async () => {
    expect(await make().detect()).toEqual({ installed: true, version: "9.9.9", path: process.execPath });
    expect(await createCodexAdapter({ which: () => null }).detect()).toEqual({ installed: false });
  });

  // `codex login status` answers by its exit code; ion keeps only how you signed in, never account details.
  it("tells signed in from signed out without account details", async () => {
    expect(await make().auth.status()).toEqual({
      signedIn: true,
      method: "ChatGPT",
      billing: "subscription",
    });
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
    expect(events.find((e) => e.type === "usage.reported")?.data).toMatchObject({
      model: "fake-codex-1",
      inputTokens: 120,
      outputTokens: 8,
      costUsd: null,
    });
    expect(events.at(-1)).toEqual({ type: "run.finished", data: { status: "done" } });
    expect(JSON.stringify(events)).not.toContain("example.com");
  });

  // The user, 2026-11-21: Codex's own rate-limit windows (account/rateLimits on codex-cli 0.153.2:
  // docs/research/usage-signals.md), reported with each run, so ion can say "62% of 5 h · resets 14:20".
  it("a Codex window snapshot is stored and shown", async () => {
    const events = await turn("hello");
    expect((events.find((e) => e.type === "usage.reported")?.data as { windows: unknown }).windows).toEqual([
      { name: "5 h", usedPercent: 62, resetsAt: "2026-11-21T14:20:00.000Z" },
      { name: "week", usedPercent: 12, resetsAt: "2026-11-25T09:00:00.000Z" },
    ]);
  });

  // Review of fb615b0, 2026-11-23: a run's total is every token it processed. Codex's inputTokens already include
  // the cached input (cachedInputTokens is a part of them), so the total is input plus output.
  it("tokens include cached context", async () => {
    const events = await turn("hello");
    expect(events.find((e) => e.type === "usage.reported")?.data).toMatchObject({
      inputTokens: 120,
      outputTokens: 8,
      totalTokens: 128,
    });
  });

  // The user, 2026-11-21: a Codex that doesn't say (an older one, or a read that failed) shows no gauge at all.
  it("a missing gauge shows Learned from errors", async () => {
    process.env.FAKE_CODEX_NO_LIMITS = "1";
    const events = await turn("hello");
    const usage = events.find((e) => e.type === "usage.reported")?.data as Record<string, unknown>;
    expect(usage).toMatchObject({ inputTokens: 120 });
    expect(usage).not.toHaveProperty("windows");
  });

  // Review, 2026-11-22: a turn Codex completed ended as a crash when its app-server exited while ion read its windows.
  it("a completed turn stays done when Codex exits while its windows are read", async () => {
    const events = await turn("completeexit");
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "run.finished", data: { status: "done" } });
  });

  // The user, 2026-11-21: Codex's used-up plan is its limit, with the reset of the window that's full.
  it("a limit error marks the agent limited until its reset", async () => {
    const events = await turn("usagelimit");
    expect(events.filter((e) => e.type === "error").map((e) => e.data)).toEqual([
      {
        code: "quota",
        retryable: false,
        message: "You've hit your usage limit",
        limit: { resetsAt: "2026-11-21T14:20:00.000Z" },
      },
    ]);
  });

  // The user, 2026-11-21: how an agent bills comes from its sign-in (ChatGPT: its plan; an API key: per token).
  it("billing comes from the sign-in", async () => {
    expect(await make().auth.status()).toMatchObject({ billing: "subscription" });
  });

  it("lists Codex's own models, without hidden ones", async () => {
    const caps = await make().capabilities();
    expect(caps.models).toEqual([
      { id: "fake-codex-1", label: "Fake Codex 1" },
      { id: "fake-codex-mini", label: "Fake Codex Mini" },
    ]);
    expect(caps).toMatchObject({ defaultModel: "fake-codex-1", modelsLive: true, approvals: "interactive" });
  });

  // Plan 20 builder, 2026-11-22: a chat on Codex with no model picked failed with model_not_found. Codex uses your
  // config.toml's model when a thread names none (gpt-6.1-sol there), and a ChatGPT sign-in can't use it; model/list
  // (the account's models) had another default. ion sends the account's default instead, and keeps your config's
  // pick when the account can use it.
  describe("the model a thread gets", () => {
    afterEach(() => delete process.env.FAKE_CODEX_CONFIG_MODEL);

    it("no pick, and your config names a model this sign-in can't use: the account's default", async () => {
      process.env.FAKE_CODEX_CONFIG_MODEL = "gpt-gone";
      const events = await turn("hello");
      expect(events[0]?.data).toMatchObject({ model: "fake-codex-1" });
      expect(said(events)).toBe("Hi there");
      expect((await make().capabilities()).defaultModel).toBe("fake-codex-1");
    });

    it("no pick, and your config's model is one it can use: Codex's own pick, shown as the default", async () => {
      process.env.FAKE_CODEX_CONFIG_MODEL = "fake-codex-mini";
      const { thread } = await whoami();
      expect(thread).not.toHaveProperty("model");
      expect((await make().capabilities()).defaultModel).toBe("fake-codex-mini");
    });

    it("a pick this sign-in can't use is refused before a turn, in plain words", async () => {
      await expect(turn("hello", { model: "gpt-gone" })).rejects.toThrow(
        "Codex can't use gpt-gone with this sign-in",
      );
    });

    it("model_not_found is a real failure with a plain reason, never retried with more effort", async () => {
      const events = await turn("modelgone");
      expect(events.filter((e) => e.type === "error").map((e) => e.data)).toEqual([
        {
          code: "model_not_found",
          retryable: false,
          message: "Codex can't use fake-codex-1 with this sign-in",
        },
      ]);
    });
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

  // The user, 2026-11-21: agents run in the OS sandbox, away from ion's own files. Codex sandboxes its own commands
  // (macOS won't nest ion's around it), and its permission profiles can deny reading a folder (checked on Codex
  // 0.153.2: docs/research/sandbox.md), so ion turns that on with ion's folders "none" and the run's own let through.
  it("runs Codex's commands in its own sandbox with ion's folders denied", async () => {
    const sandbox = {
      kind: "seatbelt" as const,
      paths: {
        deny: ["/ion-x/data"],
        read: ["/ion-x/data/skills/r1"],
        write: ["/ion-x/data/worktrees/c1"],
        noWrite: [],
      },
      dataDir: "/ion-x/data",
    };
    const { thread, overrides } = await whoami({ sandbox });
    expect(overrides).toEqual(
      expect.arrayContaining([
        'default_permissions="ion-run"',
        'permissions.ion-run.extends=":workspace"',
        "permissions.ion-run.network={enabled=true}",
        'permissions.ion-run.filesystem={"/ion-x/data"="none","/ion-x/data/skills/r1"="read","/ion-x/data/worktrees/c1"="write"}',
      ]),
    );
    // The thread's own sandbox setting would replace the profile (seen on 0.153.2: no active profile then).
    expect(thread.sandbox).toBeUndefined();
    // Task review, 2026-11-21: an approval could drop the sandbox (an escalation reached ion as a plain command
    // approval). Codex's granular policy declines every request to run outside its sandbox by itself.
    // Live, 2026-11-21: as a thread parameter Codex refused it ("granular requires experimentalApi capability"); as
    // config it's taken, and the thread keeps it.
    expect(overrides).toContain(
      "approval_policy={granular={sandbox_approval=false,rules=true,mcp_elicitations=true,request_permissions=false,skill_approval=false}}",
    );
    expect(thread.approvalPolicy).toBeUndefined();
    const plain = await whoami();
    expect(plain.thread.sandbox).toBe("workspace-write");
    expect(plain.thread.approvalPolicy).toBe("untrusted");
    expect(plain.overrides.some((o: string) => o.startsWith("default_permissions"))).toBe(false);
  });

  // The bearer key goes over stdin in the thread's config, never on the command line (other users' `ps`).
  // The user, 2026-11-20: "adding new mcp required us to follow industry standard…": your servers go the same way.
  it("gives Codex ion's server and yours, keys off the command line", async () => {
    process.env.FAKE_CODEX_LOG = join(mkdtempSync(join(tmpdir(), "ion-codex-log-")), "argv");
    const mcpServers: HttpMcpSpec[] = [
      {
        name: "ion",
        transport: "http",
        url: "http://127.0.0.1:9/mcp/k",
        headers: { Authorization: "Bearer s3cret" },
      },
      {
        name: "linear",
        transport: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer oauth-tok" },
      },
    ];
    const { thread } = await whoami({ mcpServers });
    expect(thread.config.mcp_servers).toEqual({
      ion: { url: "http://127.0.0.1:9/mcp/k", http_headers: { Authorization: "Bearer s3cret" } },
      linear: { url: "https://mcp.linear.app/mcp", http_headers: { Authorization: "Bearer oauth-tok" } },
    });
    const argv = readFileSync(process.env.FAKE_CODEX_LOG, "utf8");
    for (const secret of ["s3cret", "oauth-tok"]) expect(argv).not.toContain(secret);
  });

  // The user, 2026-11-21: "Only ion's, plus Import": in ion's chats every agent uses only the servers, hooks and
  // skills set up in ion. Codex's own servers (its config.toml, a project's .codex) are each turned off in the
  // thread's config (a `-c mcp_servers={}` merges and changes nothing, checked on codex-cli 0.153.2), and its plugins.
  it("a Codex chat in ion doesn't load Codex's own servers", async () => {
    process.env.FAKE_CODEX_OWN_MCP = JSON.stringify({ mine: { command: "echo" }, ion: { command: "old" } });
    const ion: HttpMcpSpec = { name: "ion", transport: "http", url: "http://127.0.0.1:9/mcp/k", headers: {} };
    const { thread, overrides } = await whoami({ mcpServers: [ion] });
    expect(thread.config.mcp_servers).toEqual({
      ion: { url: "http://127.0.0.1:9/mcp/k", http_headers: {} },
      mine: { enabled: false },
    });
    expect(overrides).toContain("features.plugins=false");
    expect((await whoami()).thread.config.mcp_servers).toEqual({
      mine: { enabled: false },
      ion: { enabled: false },
    });
  });

  // Task review, 2026-11-21: when Codex can't say which servers it would load (config/read fails), ion can't turn them
  // off, and a chat would quietly run with your own servers. Codex has no off switch for all of them, so it refuses.
  it("refuses a chat when it can't turn off Codex's own servers", async () => {
    process.env.FAKE_CODEX_NO_CONFIG_READ = "1";
    await expect(turn("hello")).rejects.toThrow("ion couldn't turn off Codex's own servers");
  });

  // The user, 2026-11-21: "frontier harnesses are already mature rather than reinventing the wheel. Hooks probably
  // should stay": with "Use its own tools" on, Codex keeps its own servers and plugins; its own hooks stay off.
  it("Codex keeps its own servers; its hooks are off", async () => {
    process.env.FAKE_CODEX_OWN_MCP = JSON.stringify({ mine: { command: "echo" } });
    process.env.FAKE_CODEX_OWN_HOOK = "1";
    const ion: HttpMcpSpec = { name: "ion", transport: "http", url: "http://127.0.0.1:9/mcp/k", headers: {} };
    const gate = { url: "http://127.0.0.1:9/gate/k" };
    const { thread, overrides } = await whoami({ mcpServers: [ion], gate, ownTools: true });
    expect(thread.config.mcp_servers).toEqual({ ion: { url: "http://127.0.0.1:9/mcp/k", http_headers: {} } });
    expect(overrides).not.toContain("features.plugins=false");
    const state = overrides.filter((o: string) => o.startsWith("hooks.state="));
    expect(state[0]).toContain('"/home/.codex/config.toml:post_tool_use:0:0"={enabled=false}');
    // It needn't know Codex's own servers to start: nothing of Codex's is turned off.
    process.env.FAKE_CODEX_NO_CONFIG_READ = "1";
    await expect(turn("hello", { ownTools: true })).resolves.toBeTruthy();
  });

  // The user, 2026-11-21: ion's gate still judges every call, an agent's own tools' too.
  it("an agent's own tool call is judged by ion (Codex)", async () => {
    process.env.FAKE_CODEX_MCP_SERVER = "github";
    const seen: ApprovalRequest[] = [];
    await turn("mcp", {
      ownTools: true,
      decide: async (r) => {
        seen.push(r);
        return "deny";
      },
    });
    expect(seen[0]).toMatchObject({
      toolName: "mcp__github__search_chats",
      mcpServer: "github",
      kind: "mcp",
    });
  });

  // Final review, 2026-11-21: every server reaches an agent as ion's URL (ion runs local ones), so adapters take http.
  it("takes remote servers (your local ones come as ion's URLs)", () => {
    expect(make().mcpTransports).toEqual({ http: true });
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

  // Review, 2026-11-19: an approval with no command went to the judge as "", and one asking for network access or
  // more permissions was judged as a plain command.
  it.each(["none", "network", "perms"])(
    "declines a command approval it can't judge (%s), without asking",
    async (variant) => {
      const seen: ApprovalRequest[] = [];
      const events = await turn(`command ${variant}`, {
        decide: async (r) => {
          seen.push(r);
          return "allow";
        },
      });
      expect(seen).toEqual([]);
      expect(JSON.parse(said(events))).toEqual({ decision: "decline" });
    },
  );

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

  // The user, 2026-11-19: a chat's processes are found by the marker its agent's environment carries.
  it("passes ion's env to the agent process", async () => {
    expect((await whoami({ env: { ION_CHAT: "chat_1" } })).chat).toBe("chat_1");
    expect(await whoami({ env: { ION_CHAT: "chat_2" }, gate })).toMatchObject({
      chat: "chat_2",
      gate: gate.url,
    });
  });

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

  // The user, 2026-11-21: only ion's hooks in ion's chats. Your own Codex hooks are turned off for the session
  // (`hooks.state.<key>.enabled=false`), beside the trust for ion's own; ion's gate stays.
  it("a Codex chat in ion doesn't run Codex's own hooks, and ion's gate stays", async () => {
    process.env.FAKE_CODEX_OWN_HOOK = "1";
    const { overrides, gate: url } = await whoami({ gate });
    expect(url).toBe(gate.url);
    const state = overrides.filter((o: string) => o.startsWith("hooks.state="));
    expect(state).toHaveLength(1);
    expect(state[0]).toContain('"/home/.codex/config.toml:post_tool_use:0:0"={enabled=false}');
    expect(state[0]).toContain("trusted_hash=");
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

// Task review, 2026-11-21: Codex's own skills load whatever the switch says, and it trusts a project's tools itself.
describe("what Codex's switch really turns off", () => {
  it("its servers and plugins, not its skills; Settings says it also loads its own, and uses its own trust", () => {
    const a = make();
    expect(a.ownOff).toEqual({ servers: true, skills: false, plugins: true });
    expect(a.ownTools).toBe(true);
    expect(a.ownTrust).toBe(true);
  });

  // Task review, 2026-11-22: ion's dream never searches the web; a start with no web turns Codex's web search off.
  it("turns its web search off for a start with no web", async () => {
    const { thread } = await whoami({ noWeb: true });
    expect(thread.config).toMatchObject({ web_search: "disabled", tools: { web_search: false } });
    const plain = await whoami();
    expect(plain.thread.config.web_search).toBeUndefined();
  });
});
