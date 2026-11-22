#!/usr/bin/env node
// A scripted `codex` for tests: `login status`, `--version`, and `[-c k=v…] app-server` speaking the app-server
// protocol (JSON-RPC lines, no "jsonrpc" field, as codex-cli 0.153.2). The prompt's first word picks the script:
// hello | approve | command | mcp | ask | slow | fail | crash | whoami.
// FAKE_CODEX_SIGNED_OUT=1: signed out. FAKE_CODEX_UNTRUSTED=1: never trusts a hook. FAKE_CODEX_LOG: argv log.
// FAKE_CODEX_OWN_MCP: your own servers (JSON, as config/read shows them). FAKE_CODEX_OWN_HOOK=1: a hook of your own,
// on unless a hooks.state override turns its key off.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const signedOut = process.env.FAKE_CODEX_SIGNED_OUT === "1";
if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify(argv)}\n`);

if (argv[0] === "--version") {
  console.log("codex-cli 9.9.9");
  process.exit(0);
}
if (argv[0] === "login" && argv[1] === "status") {
  // The real `codex login status` prints to stderr (codex-cli 0.153.2).
  console.error(signedOut ? "Not logged in" : "Logged in using ChatGPT");
  process.exit(signedOut ? 1 : 0);
}
if (argv.at(-1) !== "app-server") process.exit(2);

const overrides = argv.filter((_, i) => argv[i - 1] === "-c");
const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const notify = (method, params) => out({ method, params });
let nextId = 0;
const waiting = new Map();
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    out({ id, method, params });
  });

/** ion's hook from the -c overrides, its (made-up) hash, and whether a hooks.state override trusts that hash. */
function hooks() {
  const hook = overrides.find((o) => o.startsWith("hooks.PreToolUse="));
  if (!hook) return [];
  const command = JSON.parse(/command=("(?:[^"\\]|\\.)*")/.exec(hook)[1]);
  const hash = `sha256:${[...command].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(16)}`;
  const trusted =
    process.env.FAKE_CODEX_UNTRUSTED !== "1" &&
    overrides.some((o) => o.startsWith("hooks.state=") && o.includes(hash));
  const key = "/<session-flags>/config.toml:pre_tool_use:0:0";
  return [
    ...ownHooks(),
    {
      key,
      eventName: "preToolUse",
      handlerType: "command",
      command,
      source: "sessionFlags",
      enabled: true,
      currentHash: hash,
      trustStatus: trusted ? "trusted" : "untrusted",
    },
  ];
}

/** Your own hook (FAKE_CODEX_OWN_HOOK), off when a hooks.state override says `"<key>"={enabled=false}`. */
function ownHooks() {
  if (process.env.FAKE_CODEX_OWN_HOOK !== "1") return [];
  const key = "/home/.codex/config.toml:post_tool_use:0:0";
  const off = overrides.some((o) => o.startsWith("hooks.state=") && o.includes(`"${key}"={enabled=false}`));
  const base = {
    key,
    eventName: "postToolUse",
    handlerType: "command",
    command: "echo mine",
    source: "user",
  };
  return [{ ...base, enabled: !off, isManaged: false, currentHash: "sha256:own", trustStatus: "trusted" }];
}

let thread = null;
let turnParams = null;
/** The prompt's second word: which variant of a script. */
let variant = "";
let interrupt = null;
const T = { threadId: "thread-1", turnId: "turn-1" };
const item = (method, it) => notify(method, { ...T, item: it, startedAtMs: 1, completedAtMs: 2 });
const say = (text) => {
  const it = { type: "agentMessage", id: `msg-${nextId++}`, text: "" };
  item("item/started", it);
  notify("item/agentMessage/delta", { ...T, itemId: it.id, delta: text });
  item("item/completed", { ...it, text });
};
const end = (status, error = null) =>
  notify("turn/completed", { threadId: T.threadId, turn: { id: T.turnId, items: [], status, error } });

const SCRIPTS = {
  async hello() {
    notify("item/reasoning/summaryTextDelta", { ...T, itemId: "r1", delta: "thinking", summaryIndex: 0 });
    const it = { type: "agentMessage", id: "m1", text: "" };
    item("item/started", it);
    notify("item/agentMessage/delta", { ...T, itemId: "m1", delta: "Hi" });
    notify("item/agentMessage/delta", { ...T, itemId: "m1", delta: " there" });
    item("item/completed", { ...it, text: "Hi there" });
    const last = {
      inputTokens: 120,
      outputTokens: 8,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 128,
    };
    notify("thread/tokenUsage/updated", {
      ...T,
      tokenUsage: { total: last, last, modelContextWindow: 1000 },
    });
    end("completed");
  },
  async approve() {
    const change = { path: `${thread.cwd}/notes.md`, kind: { type: "add" }, diff: "hi\n" };
    const it = { type: "fileChange", id: "f1", changes: [change], status: "inProgress" };
    item("item/started", it);
    const r = await ask("item/fileChange/requestApproval", {
      ...T,
      itemId: "f1",
      startedAtMs: 1,
      reason: null,
      grantRoot: null,
    });
    const ok = r.decision === "accept" || r.decision === "acceptForSession";
    item("item/completed", { ...it, status: ok ? "completed" : "declined" });
    end("completed");
  },
  async command() {
    const it = {
      type: "commandExecution",
      id: "c1",
      command: "/bin/zsh -lc 'npm test'",
      cwd: thread.cwd,
      status: "inProgress",
    };
    item("item/started", it);
    // Variants: none (no command), network (a network approval), perms (more permissions).
    const extra = {
      none: { command: null },
      network: { networkApprovalContext: { host: "example.com", protocol: "https" } },
      perms: { additionalPermissions: { fileSystem: { write: ["/"] } } },
    }[variant];
    const r = await ask("item/commandExecution/requestApproval", {
      ...T,
      itemId: "c1",
      kind: "command",
      command: it.command,
      cwd: thread.cwd,
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
      ...extra,
    });
    item("item/completed", {
      ...it,
      status: r.decision === "decline" ? "declined" : "completed",
      aggregatedOutput: "ok\n",
      exitCode: 0,
    });
    say(JSON.stringify(r));
    end("completed");
  },
  async mcp() {
    const srv = process.env.FAKE_CODEX_MCP_SERVER ?? "ion";
    const it = {
      type: "mcpToolCall",
      id: "m1",
      server: srv,
      tool: "search_chats",
      arguments: { query: "kiwi" },
      status: "inProgress",
    };
    item("item/started", it);
    const _meta = { codex_approval_kind: "mcp_tool_call", tool_params: { query: "kiwi" } };
    const r = await ask("mcpServer/elicitation/request", {
      threadId: T.threadId,
      turnId: T.turnId,
      serverName: srv,
      mode: "form",
      _meta,
      message: `Allow the ${srv} MCP server to run tool "search_chats"?`,
      requestedSchema: { type: "object", properties: {} },
    });
    const form = await ask("mcpServer/elicitation/request", {
      threadId: T.threadId,
      turnId: null,
      serverName: "x",
      mode: "form",
      _meta: null,
      message: "Your name?",
      requestedSchema: { type: "object", properties: {} },
    });
    item("item/completed", {
      ...it,
      status: r.action === "accept" ? "completed" : "failed",
      result: { content: [{ type: "text", text: "found" }] },
    });
    say(JSON.stringify({ tool: r, form }));
    end("completed");
  },
  /** An edit approval for an item Codex never started (no files known). */
  async editunknown() {
    const r = await ask("item/fileChange/requestApproval", {
      ...T,
      itemId: "f9",
      startedAtMs: 1,
      reason: null,
      grantRoot: null,
    });
    say(JSON.stringify(r));
    end("completed");
  },
  /** An MCP approval form for search_chats, with these calls in flight: one | two | done | other. */
  async mcpform() {
    const call = (id, tool) => ({
      type: "mcpToolCall",
      id,
      server: "ion",
      tool,
      arguments: { id },
      status: "inProgress",
    });
    if (variant === "other") item("item/started", call("m1", "memory_write"));
    else item("item/started", call("m1", "search_chats"));
    if (variant === "two") item("item/started", call("m2", "search_chats"));
    if (variant === "done") item("item/completed", { ...call("m1", "search_chats"), status: "completed" });
    const r = await ask("mcpServer/elicitation/request", {
      threadId: T.threadId,
      turnId: T.turnId,
      serverName: "ion",
      mode: "form",
      _meta: { codex_approval_kind: "mcp_tool_call" },
      message: 'Allow the ion MCP server to run tool "search_chats"?',
      requestedSchema: { type: "object", properties: {} },
    });
    say(JSON.stringify(r));
    end("completed");
  },
  async ask() {
    const r = await ask("item/tool/requestUserInput", {
      ...T,
      itemId: "q1",
      questions: [{ id: "q", question: "Which?" }],
      isBlocking: true,
    });
    say(JSON.stringify(r));
    end("completed");
  },
  async slow() {
    const it = {
      type: "commandExecution",
      id: "c2",
      command: "/bin/zsh -lc 'sleep 30'",
      cwd: thread.cwd,
      status: "inProgress",
    };
    item("item/started", it);
    const stopped = await new Promise((resolve) => {
      interrupt = () => resolve(true);
      setTimeout(() => resolve(false), 30_000);
    });
    item("item/completed", { ...it, status: stopped ? "failed" : "completed" });
    end(stopped ? "interrupted" : "completed");
  },
  async fail() {
    const error = {
      message: "Rate limit reached",
      codexErrorInfo: "rateLimitExceeded",
      additionalDetails: null,
    };
    notify("error", { ...T, error, willRetry: true });
    notify("error", { ...T, error, willRetry: false });
    end("failed", error);
  },
  crash: () => process.exit(3),
  async whoami() {
    const turn = { ...turnParams, input: undefined };
    const env = { gate: process.env.ION_GATE_URL ?? null, chat: process.env.ION_CHAT ?? null };
    say(JSON.stringify({ overrides, thread, turn, ...env }));
    end("completed");
  },
};

const MODELS = [
  { id: "fake-codex-1", model: "fake-codex-1", displayName: "Fake Codex 1", hidden: false, isDefault: true },
  {
    id: "fake-codex-mini",
    model: "fake-codex-mini",
    displayName: "Fake Codex Mini",
    hidden: false,
    isDefault: false,
  },
  { id: "fake-hidden", model: "fake-hidden", displayName: "Hidden", hidden: true, isDefault: false },
];

const threadOf = (id, p) => ({
  thread: { id, cwd: p.cwd ?? null, turns: [] },
  model: p.model ?? "fake-codex-1",
});

const METHODS = {
  initialize: () => ({
    userAgent: "fake",
    codexHome: "/nowhere",
    platformFamily: "unix",
    platformOs: "macos",
  }),
  "account/read": () =>
    signedOut
      ? { account: null, requiresOpenaiAuth: true }
      : {
          account: { type: "chatgpt", email: "someone@example.com", planType: "plus" },
          requiresOpenaiAuth: true,
        },
  "config/read": () => {
    if (process.env.FAKE_CODEX_NO_CONFIG_READ === "1")
      throw { code: -32601, message: "unknown method config/read" };
    return { config: { mcp_servers: JSON.parse(process.env.FAKE_CODEX_OWN_MCP ?? "{}") } };
  },
  "hooks/list": (p) => ({ data: [{ cwd: p.cwds?.[0] ?? "", hooks: hooks(), warnings: [], errors: [] }] }),
  "model/list": () => ({ data: MODELS, nextCursor: null }),
  "thread/start": (p) => {
    thread = p;
    return threadOf("thread-1", p);
  },
  "thread/resume": (p) => {
    if (p.threadId.startsWith("gone"))
      throw { code: -32600, message: `no rollout found for thread id ${p.threadId}` };
    thread = p;
    return threadOf(p.threadId, p);
  },
  "turn/start": (p) => {
    turnParams = p;
    const word = p.input
      .map((x) => x.text)
      .join(" ")
      .trim()
      .split(/\s+/)[0];
    variant =
      p.input
        .map((x) => x.text)
        .join(" ")
        .trim()
        .split(/\s+/)[1] ?? "";
    setImmediate(() => void (SCRIPTS[word] ?? SCRIPTS.hello)());
    return { turn: { id: T.turnId, items: [], status: "inProgress", error: null } };
  },
  "turn/interrupt": () => {
    interrupt?.();
    return {};
  },
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === undefined) return waiting.get(m.id)?.(m.result ?? { error: m.error });
  if (m.id === undefined) return; // a notification (initialized)
  const handler = METHODS[m.method];
  if (!handler) return out({ id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } });
  try {
    out({ id: m.id, result: handler(m.params ?? {}) });
  } catch (e) {
    out({ id: m.id, error: e });
  }
});
