#!/usr/bin/env node
// A tiny ACP agent for tests. Prompt's first word: hello | approve | slow. FAKE_ACP_SIGNED_OUT=1 → -32000.
import { createInterface } from "node:readline";

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
  badinput: (id) => send({ id, error: { code: -32602, message: "Invalid params" } }),
};

async function prompt(id, { sessionId, prompt: blocks }) {
  const text = blocks
    .map((b) => b.text ?? "")
    .join(" ")
    .trim();
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
  if (text.startsWith("whoami")) {
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: JSON.stringify({
          meta: metas.get(sessionId),
          env: process.env.FAKE_ACP_ENV ?? null,
          mcpServers: mcps.get(sessionId),
        }),
      },
    });
    return send({ id, result: { stopReason: "end_turn", usage: { inputTokens: 7, outputTokens: 3 } } });
  }
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
function initialize(m) {
  const caps = process.env.FAKE_ACP_CAPS ?? "resume";
  const agentCapabilities = {
    loadSession: caps !== "none",
    ...(caps === "resume" ? { sessionCapabilities: { resume: {} } } : {}),
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

function newSession(m) {
  if (process.env.FAKE_ACP_SIGNED_OUT === "1")
    return send({ id: m.id, error: { code: -32000, message: "Authentication required" } });
  sessions.set("s1", m.params.cwd);
  metas.set("s1", m.params._meta ?? null);
  mcps.set("s1", m.params.mcpServers ?? null);
  return send({
    id: m.id,
    result: {
      sessionId: "s1",
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "fake-1",
          options: [],
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
  if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: "Method not found" } });
});
