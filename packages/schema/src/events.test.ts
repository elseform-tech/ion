import { describe, expect, it } from "vitest";
import { ADAPTER_EVENT_TYPES, DAEMON_EVENT_TYPES, EVENT_TYPES, isDaemonOnly, parseEvent } from "./index.js";

const valid = {
  v: 1,
  id: "01JD0000000000000000000000",
  chatId: "c1",
  runId: "r1",
  seq: 3,
  ts: "2026-11-17T10:00:00.000Z",
  origin: "adapter",
  type: "run.finished",
  data: { status: "done" },
};

describe("parseEvent", () => {
  it("parses a valid run.finished event", () => {
    const e = parseEvent(valid);
    expect(e.type).toBe("run.finished");
    expect(e.seq).toBe(3);
  });

  it("rejects unknown event types", () => {
    expect(() => parseEvent({ ...valid, type: "run.exploded" })).toThrow();
  });

  it("rejects data that doesn't match its type", () => {
    expect(() => parseEvent({ ...valid, data: { status: "great" } })).toThrow();
  });

  it("rejects v other than 1 and seq below 1", () => {
    expect(() => parseEvent({ ...valid, v: 2 })).toThrow();
    expect(() => parseEvent({ ...valid, seq: 0 })).toThrow();
  });

  it("accepts any object data for types without a data schema", () => {
    expect(parseEvent({ ...valid, type: "tool.output", data: { chunk: "ok" } }).type).toBe("tool.output");
  });

  it("allows null chatId and runId for daemon-wide events", () => {
    const e = parseEvent({
      ...valid,
      chatId: null,
      runId: null,
      origin: "daemon",
      type: "memory.forgotten",
      data: {},
    });
    expect(e.runId).toBeNull();
  });
});

describe("event type sets", () => {
  it("keeps adapter and daemon types disjoint and complete", () => {
    expect(new Set([...ADAPTER_EVENT_TYPES, ...DAEMON_EVENT_TYPES]).size).toBe(EVENT_TYPES.length);
    expect(ADAPTER_EVENT_TYPES.length + DAEMON_EVENT_TYPES.length).toBe(EVENT_TYPES.length);
  });

  it("knows which types only the daemon may emit", () => {
    expect(isDaemonOnly("need.raised")).toBe(true);
    expect(isDaemonOnly("tool.started")).toBe(false);
  });
});
