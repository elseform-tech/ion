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
  ["usage.reported", { model: "haiku", inputTokens: 10, outputTokens: 5, costUsd: null }],
  ["run.started", { harness: "fake", model: "m", effort: null, authMethod: null }],
];

const invalid: [string, Record<string, unknown>, string?][] = [
  ["message.delta", { text: 3 }],
  ["tool.started", { toolId: "t1", name: "Read", kind: "magic", summary: "x" }],
  ["tool.finished", { toolId: "t1", ok: "yes", summary: null }],
  ["file.changed", { path: "a", change: "rename", added: 0, removed: 0 }],
  ["approval.resolved", { requestId: "q1", decision: "maybe", by: "policy" }, "daemon"],
  ["usage.reported", { model: "m", inputTokens: -1, outputTokens: 0, costUsd: null }],
  ["run.started", { harness: "fake", model: "m", effort: null }],
];

describe("event payloads", () => {
  it.each(valid)("accepts a valid %s", (type, data, origin) => {
    expect(parseEvent(at(type, data, origin)).type).toBe(type);
  });
  it.each(invalid)("rejects a wrong %s", (type, data, origin) => {
    expect(() => parseEvent(at(type, data, origin))).toThrow();
  });
});
