import { describe, expect, it } from "vitest";
import { parseEvent } from "./index.js";

const at = (type: string, data: Record<string, unknown>, origin = "adapter") => ({
  v: 1,
  id: "01JD0000000000000000000000",
  chatId: "c1",
  runId: "r1",
  seq: 1,
  ts: "2026-11-17T10:00:00.000Z",
  origin,
  type,
  data,
});

const valid: [string, Record<string, unknown>, string?][] = [
  ["message.delta", { text: "Hi" }],
  ["message.completed", { text: "Hi there" }],
  ["thinking.delta", { text: "Checking totals" }],
  ["tool.started", { toolId: "t1", name: "Read", kind: "read", summary: "src/a.ts" }],
  ["tool.output", { toolId: "t1", text: "ok" }],
  ["tool.finished", { toolId: "t1", ok: true, summary: null }],
  ["file.changed", { path: "notes.md", change: "add", added: 1, removed: null }],
  ["approval.requested", { requestId: "q1", toolId: "t2", kind: "edit", summary: "Edit notes.md" }],
  ["approval.resolved", { requestId: "q1", decision: "deny", by: "policy" }, "daemon"],
  ["approval.resolved", { requestId: "q1", decision: "allow", by: "you" }, "daemon"],
  [
    "approval.resolved",
    { requestId: "q1", decision: "deny", by: "ion", reason: "Reads your SSH keys" },
    "daemon",
  ],
  ["approval.resolved", { requestId: "q1", decision: "allow", by: "full" }, "daemon"],
  ["usage.reported", { model: "haiku", inputTokens: 10, outputTokens: 5, costUsd: null }],
  ["run.started", { harness: "fake", model: "m", effort: null, authMethod: null }],
  [
    "need.raised",
    {
      needId: "n1",
      requestId: "q1",
      kind: "command",
      summary: "Run pnpm test",
      detail: null,
      dedupeKey: "k",
    },
    "daemon",
  ],
  ["need.resolved", { needId: "n1", decision: "superseded", by: "daemon" }, "daemon"],
  ["run.queued", {}, "daemon"],
  ["run.retrying", { attempt: 1, delayS: 3.2, reason: "rate limit", effort: null }, "daemon"],
  ["chat.created", { title: "t", projectId: "p", worktree: "/w", branch: "ion/t-abc123" }, "daemon"],
  ["chat.created", { title: "t", projectId: null }, "daemon"],
  // Plan 09: ions.
  ["chat.created", { title: "t", projectId: "p", by: "ion" }, "daemon"],
  ["ion.heard", { text: "Check the totals" }, "daemon"],
  ["ion.said", { text: "On it." }, "daemon"],
  [
    "ion.said",
    { text: "On it.", card: { kind: "threads", threads: [{ chatId: "c2", projectId: "p" }] } },
    "daemon",
  ],
  [
    "ion.said",
    { text: "Always?", card: { kind: "suggest", suggestionId: "s1", question: "Use QA?", choice: "Yes" } },
    "daemon",
  ],
  [
    "ion.said",
    {
      text: "Failing",
      card: { kind: "flag", decisionId: "d1", question: "Use QA?", choice: "Yes", failed: 2 },
    },
    "daemon",
  ],
  ["suggestion.answered", { suggestionId: "s1", keep: true }, "daemon"],
  [
    "need.raised",
    {
      ...{ needId: "n2", requestId: "q2", kind: "ask", summary: "Use QA?", detail: null, dedupeKey: "k" },
      via: { note: "storefront's ion: first time this comes up" },
      heldFor: "n1",
    },
    "daemon",
  ],
];

const invalid: [string, Record<string, unknown>, string?][] = [
  ["message.delta", { text: 3 }],
  ["tool.started", { toolId: "t1", name: "Read", kind: "magic", summary: "x" }],
  ["tool.finished", { toolId: "t1", ok: "yes", summary: null }],
  ["file.changed", { path: "a", change: "rename", added: 0, removed: 0 }],
  ["approval.resolved", { requestId: "q1", decision: "maybe", by: "policy" }, "daemon"],
  ["usage.reported", { model: "m", inputTokens: -1, outputTokens: 0, costUsd: null }],
  ["run.started", { harness: "fake", model: "m", effort: null }],
  ["need.raised", { needId: "n1", requestId: "q1", kind: "command", summary: "x", detail: null }, "daemon"],
  ["need.resolved", { needId: "n1", decision: "maybe", by: "you" }, "daemon"],
  ["run.retrying", { attempt: 0, delayS: -1, reason: "x", effort: null }, "daemon"],
  ["chat.created", { title: "t", projectId: "p", by: "you" }, "daemon"],
  ["ion.said", { text: "x", card: { kind: "threads" } }, "daemon"],
  ["ion.said", { text: "x", card: { kind: "nope" } }, "daemon"],
  ["suggestion.answered", { suggestionId: "s1", keep: "yes" }, "daemon"],
];

describe("event payloads", () => {
  it.each(valid)("accepts a valid %s", (type, data, origin) => {
    expect(parseEvent(at(type, data, origin)).type).toBe(type);
  });
  it.each(invalid)("rejects a wrong %s", (type, data, origin) => {
    expect(() => parseEvent(at(type, data, origin))).toThrow();
  });
});
