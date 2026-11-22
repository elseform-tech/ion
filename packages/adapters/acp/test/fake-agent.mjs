#!/usr/bin/env node
// A tiny ACP agent for tests. Prompt's first word: hello | approve | slow. FAKE_ACP_SIGNED_OUT=1 → -32000.
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

// `--forget <id>`: an agent's own "delete this session" command; recorded, then it exits.
const forgetAt = process.argv.indexOf("--forget");
if (forgetAt >= 0) {
  if (process.env.FAKE_ACP_RECORD)
    appendFileSync(
      process.env.FAKE_ACP_RECORD,
      `${JSON.stringify({ forgot: process.argv[forgetAt + 1] })}\n`,
    );
  process.exit(0);
}

const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
let nextId = 1000;
const waiting = new Map();
const ask = (method, params) =>
  new Promise((r) => {
    const id = ++nextId;
    waiting.set(id, r);
    send({ id, method, params });
  });
let cancel = null;
const sessions = new Map();
const metas = new Map();
const opened = new Map();
const mcps = new Map();

/** Prompts answered in one step: a refusal, a crash, RPC errors. */
const QUICK = {
  refuse: (id) => send({ id, result: { stopReason: "cancelled" } }),
  crash: () => process.exit(3),
  ratelimit: (id) => send({ id, error: { code: -32603, message: "Rate limit exceeded (429)" } }),
  usagelimit: (id) =>
    send({ id, error: { code: -32603, message: "AI_APICallError: Free usage limit reached (429)" } }),
  badinput: (id) => send({ id, error: { code: -32602, message: "Invalid params" } }),
  // Like Grok 1.0.92 (probed 2026-11-22): its usage and cost (in 1e-10 USD ticks) in the prompt result's _meta.
  grokusage: (id) =>
    send({
      id,
      result: {
        stopReason: "end_turn",
        _meta: { inputTokens: 28175, outputTokens: 28, usage: { costUsdTicks: 532540000 } },
      },
    }),
  // Like opencode with an expired key: takes the prompt and never says anything.
  silent: () => {},
};

/**
 * Like opencode out of quota (live, 2026-11-21): updates that aren't progress (its commands list) and nothing else,
 * with its own log on stderr saying why (`quota`), or not (`busy`).
 */
const NO_PROGRESS = {
  quota: true,
  busy: false,
};

/** A tool that runs a while (longer than the silence check) before it's done; then a word. */
async function longTool(id, sessionId) {
  update(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "lt",
    title: "make",
    kind: "execute",
    status: "in_progress",
  });
  await new Promise((r) => setTimeout(r, 1500));
  update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "lt", status: "completed" });
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "built" } });
  send({ id, result: { stopReason: "end_turn" } });
}

/** Quiet a while (ion holding a call elsewhere, in the test), then a word. */
async function quietThenSay(id, sessionId) {
  await new Promise((r) => setTimeout(r, 1500));
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } });
  send({ id, result: { stopReason: "end_turn" } });
}

/** The prompt's text, and ion's standing instructions (their own first block) apart from it. */
function split(blocks) {
  const all = blocks.map((b) => b.text ?? "");
  const told = all.find((t) => t.startsWith("<ion-instructions ")) ?? null;
  const text = all
    .filter((t) => t !== told)
    .join(" ")
    .trim();
  return { told, text };
}

/** What the agent was given: session options, env, MCP servers, ion's instructions. */
function whoami(id, sessionId, told) {
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: {
      type: "text",
      text: JSON.stringify({
        meta: metas.get(sessionId),
        env: process.env.FAKE_ACP_ENV ?? null,
        chat: process.env.ION_CHAT ?? null,
        mcpServers: mcps.get(sessionId),
        argv: process.argv.slice(2),
        ...(told ? { instructions: told } : {}),
      }),
    },
  });
  return send({ id, result: { stopReason: "end_turn", usage: { inputTokens: 7, outputTokens: 3 } } });
}

/** Reads a file with a command it starts (as an agent's shell tool would) and says what came back. */
function catFile(id, sessionId, file) {
  let said;
  try {
    said = execFileSync("cat", [file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    said = `failed: ${String(e.stderr ?? e.message).trim()}`;
  }
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: said } });
  return send({ id, result: { stopReason: "end_turn" } });
}

/** Updates that aren't progress, forever; its log says why first when it's out of quota. */
function noProgress(sessionId, text) {
  if (NO_PROGRESS[text])
    process.stderr.write(
      'timestamp=2026-11-21T17:20:48Z level=ERROR message="stream error" providerID=opencode error.error="AI_APICallError: Free usage limit reached. Try again later." more=1\n',
    );
  const tick = () => update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [] });
  tick();
  setInterval(tick, 50);
}

/** Prompts that go quiet, or take a while, on purpose. */
const TIMED = {
  quota: (_id, sessionId) => noProgress(sessionId, "quota"),
  busy: (_id, sessionId) => noProgress(sessionId, "busy"),
  longtool: longTool,
  quietheld: quietThenSay,
};

/** A prompt that's timed on purpose, or `cat <file>`: handled here (true). */
function special(id, sessionId, text) {
  if (text in TIMED) TIMED[text](id, sessionId);
  else if (text.startsWith("cat ")) catFile(id, sessionId, text.slice(4));
  else return false;
  return true;
}

async function prompt(id, { sessionId, prompt: blocks }) {
  const { told, text } = split(blocks);
  if (special(id, sessionId, text)) return;
  const cwd = sessions.get(sessionId);
  if (text.startsWith("approve")) {
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Write notes.md",
      kind: "edit",
      status: "pending",
    });
    const res = await ask("session/request_permission", {
      sessionId,
      toolCall: {
        toolCallId: "t1",
        title: "Write notes.md",
        kind: "edit",
        locations: [{ path: `${cwd}/notes.md` }],
      },
      options: [
        { optionId: "yes", name: "Allow", kind: "allow_once" },
        { optionId: "always", name: "Always", kind: "allow_always" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ],
    });
    const allowed = res.outcome?.outcome === "selected" && res.outcome.optionId !== "no";
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: allowed ? "completed" : "failed",
      ...(allowed ? { content: [{ type: "diff", path: `${cwd}/notes.md`, newText: "hi\n" }] } : {}),
    });
  } else if (text.startsWith("slow")) {
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "t2",
      title: "sleep 30",
      kind: "execute",
      status: "in_progress",
    });
    const cancelled = await new Promise((r) => {
      cancel = () => r(true);
      setTimeout(() => r(false), 30_000);
    });
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t2",
      status: cancelled ? "failed" : "completed",
    });
    return send({ id, result: { stopReason: cancelled ? "cancelled" : "end_turn" } });
  }
  const quick = QUICK[text.split(" ")[0]];
  if (quick) return quick(id);
  if (text.startsWith("howopened")) {
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `${sessionId} via ${opened.get(sessionId) ?? "session/new"}` },
    });
    return send({ id, result: { stopReason: "end_turn" } });
  }
  if (text.startsWith("whoami")) return whoami(id, sessionId, told);

  update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking" } });
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi " } });
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "there" } });
  update(sessionId, {
    sessionUpdate: "usage_update",
    used: 100,
    size: 1000,
    cost: { amount: 0.002, currency: "USD" },
  });
  update(sessionId, { sessionUpdate: "something_new" });
  send({ id, result: { stopReason: "end_turn" } });
}

// FAKE_ACP_CAPS: "resume" (default: resume and load), "load" (load only) or "none".
// FAKE_ACP_NO_HTTP=1: takes no remote MCP servers (stdio only, ACP's baseline).
function initialize(m) {
  const caps = process.env.FAKE_ACP_CAPS ?? "resume";
  const agentCapabilities = {
    loadSession: caps !== "none",
    mcpCapabilities: { http: !process.env.FAKE_ACP_NO_HTTP },
    ...(caps === "resume" ? { sessionCapabilities: { resume: {}, close: {} } } : {}),
  };
  send({
    id: m.id,
    result: { protocolVersion: 1, agentCapabilities, authMethods: [{ id: "login", name: "Login" }] },
  });
}

function continueSession(m) {
  const { sessionId, cwd } = m.params;
  if (sessionId === "gone") return send({ id: m.id, error: { code: -32002, message: "Session not found" } });
  sessions.set(sessionId, cwd);
  opened.set(sessionId, m.method);
  // session/load replays the old conversation before answering.
  if (m.method === "session/load")
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "OLD HISTORY" },
    });
  send({ id: m.id, result: { configOptions: [] } });
}

// FAKE_ACP_RECORD=<file>: each new session appends its folder and whether it could write FAKE_ACP_TOUCH (a sandbox
// that denies that path stops it).
function record(cwd) {
  if (!process.env.FAKE_ACP_RECORD) return;
  let wrote = "no-touch";
  if (process.env.FAKE_ACP_TOUCH)
    try {
      writeFileSync(process.env.FAKE_ACP_TOUCH, "x");
      wrote = "wrote";
    } catch {
      wrote = "blocked";
    }
  const row = {
    cwd,
    wrote,
    args: process.argv.slice(2),
    pid: process.pid,
    gate: process.env.ION_GATE_URL ?? null,
  };
  appendFileSync(process.env.FAKE_ACP_RECORD, `${JSON.stringify(row)}\n`);
}

function newSession(m) {
  if (process.env.FAKE_ACP_SIGNED_OUT === "1")
    return send({ id: m.id, error: { code: -32000, message: "Authentication required" } });
  record(m.params.cwd);
  // s1, then s2… for more sessions in one process (ion's warm judge).
  const sessionId = `s${sessions.size + 1}`;
  sessions.set(sessionId, m.params.cwd);
  metas.set(sessionId, m.params._meta ?? null);
  mcps.set(sessionId, m.params.mcpServers ?? null);
  return send({
    id: m.id,
    result: {
      sessionId,
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "fake-1",
          options: [
            { value: "fake-1", name: "Fake One" },
            { value: "fake-2", name: "Fake Two" },
          ],
        },
      ],
    },
  });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id !== undefined && waiting.has(m.id)) {
    waiting.get(m.id)(m.result);
    waiting.delete(m.id);
    return;
  }
  if (process.env.FAKE_ACP_HANG === "1") return; // never answers
  if (m.method === "initialize") return initialize(m);
  if (m.method === "session/resume" || m.method === "session/load") return continueSession(m);
  if (m.method === "session/new") return newSession(m);
  if (m.method === "session/set_config_option") return send({ id: m.id, result: { configOptions: [] } });
  if (m.method === "session/prompt") return void prompt(m.id, m.params);
  if (m.method === "session/cancel") return cancel?.();
  if (m.method === "session/close") {
    if (process.env.FAKE_ACP_RECORD)
      appendFileSync(process.env.FAKE_ACP_RECORD, `${JSON.stringify({ closed: m.params.sessionId })}\n`);
    return send({ id: m.id, result: {} });
  }
  if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: "Method not found" } });
});
