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
  if (text.startsWith("refuse")) return send({ id, result: { stopReason: "cancelled" } });
  if (text.startsWith("whoami")) {
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: JSON.stringify({ meta: metas.get(sessionId), env: process.env.FAKE_ACP_ENV ?? null }),
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

createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id !== undefined && waiting.has(m.id)) {
    waiting.get(m.id)(m.result);
    waiting.delete(m.id);
    return;
  }
  if (process.env.FAKE_ACP_HANG === "1") return; // never answers
  if (m.method === "initialize")
    return send({ id: m.id, result: { protocolVersion: 1, authMethods: [{ id: "login", name: "Login" }] } });
  if (m.method === "session/new") {
    if (process.env.FAKE_ACP_SIGNED_OUT === "1")
      return send({ id: m.id, error: { code: -32000, message: "Authentication required" } });
    sessions.set("s1", m.params.cwd);
    metas.set("s1", m.params._meta ?? null);
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
  if (m.method === "session/set_config_option") return send({ id: m.id, result: { configOptions: [] } });
  if (m.method === "session/prompt") return void prompt(m.id, m.params);
  if (m.method === "session/cancel") return cancel?.();
  if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: "Method not found" } });
});
