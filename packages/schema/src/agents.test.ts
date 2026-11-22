import { describe, expect, it } from "vitest";
import { type AgentUsage, parseEvent, usageLine } from "./index.js";

const at = (type: string, data: Record<string, unknown>) => ({
  v: 1,
  id: "01JD0000000000000000000000",
  chatId: "c1",
  runId: "r1",
  seq: 1,
  ts: "2026-11-21T10:00:00.000Z",
  origin: "adapter",
  type,
  data,
});

/** 2026-11-21, a Saturday, at a local time. */
const local = (h: number, m = 0, day = 21) => new Date(2026, 10, day, h, m);
const none = { tokens: 0, costUsd: 0 };
const usage = (u: Partial<AgentUsage>): AgentUsage => ({
  harness: "codex",
  label: "Codex",
  billing: null,
  today: none,
  week: none,
  windows: [],
  limitedUntil: null,
  ...u,
});

describe("usage events", () => {
  it("usage.reported takes tokens, cost and the agent's windows", () => {
    const windows = [{ name: "5 h", usedPercent: 62, resetsAt: "2026-11-21T14:20:00.000Z" }];
    expect(() =>
      parseEvent(at("usage.reported", { model: "m", inputTokens: 5, outputTokens: 2, windows })),
    ).not.toThrow();
    const bad = [{ name: "5 h", usedPercent: -1, resetsAt: null }];
    expect(() =>
      parseEvent(at("usage.reported", { model: "m", inputTokens: 5, outputTokens: 2, windows: bad })),
    ).toThrow();
  });

  it("a failure can say it's the agent's limit, and when it resets", () => {
    const limit = { resetsAt: "2026-11-21T16:00:00.000Z" };
    const e = { code: "usage_limit", retryable: false, message: "Limit reached", limit };
    expect(() => parseEvent(at("error", e))).not.toThrow();
    expect(() => parseEvent(at("error", { ...e, limit: {} }))).not.toThrow();
    expect(() => parseEvent(at("error", { ...e, limit: { resetsAt: "soon" } }))).toThrow();
  });
});

describe("usageLine", () => {
  // The user, 2026-11-21: "Codex · 62% of 5 h · resets 14:20" in Settings → Agents and `ion status`.
  it("a Codex window snapshot is stored and shown", () => {
    const windows = [
      { name: "5 h", usedPercent: 62, resetsAt: local(14, 20).toISOString() },
      { name: "week", usedPercent: 30, resetsAt: local(9, 0, 25).toISOString() },
    ];
    expect(usageLine(usage({ windows }), local(12))).toEqual({
      text: "62% of 5 h · resets 14:20",
      percent: 62,
      limited: false,
    });
  });

  // The user, 2026-11-21: "Claude Code · limited until 16:00".
  it("a limit error marks the agent limited until its reset", () => {
    const u = usage({ label: "Claude Code", limitedUntil: local(16).toISOString() });
    expect(usageLine(u, local(12))).toEqual({ text: "limited until 16:00", percent: null, limited: true });
    // Past the reset it isn't limited any more.
    expect(usageLine(u, local(16, 1)).limited).toBe(false);
  });

  // The user, 2026-11-21: a gauge the agent no longer reports is never shown frozen at an old value.
  it("a missing gauge shows Learned from errors", () => {
    expect(usageLine(usage({ billing: "subscription" }), local(12)).text).toBe("Learned from errors");
    // A window whose reset has passed is an old value: gone.
    const old = [{ name: "5 h", usedPercent: 90, resetsAt: local(11).toISOString() }];
    expect(usageLine(usage({ windows: old }), local(12)).text).toBe("Learned from errors");
  });

  // The user, 2026-11-21: how an agent bills comes from its sign-in; unknown is never shown as Free.
  it("billing comes from the sign-in", () => {
    expect(usageLine(usage({ label: "opencode", billing: "free" }), local(12)).text).toBe("Free");
    expect(usageLine(usage({ billing: null }), local(12)).text).not.toContain("Free");
    const api = usage({ billing: "api", week: { tokens: 9000, costUsd: 1.2 } });
    expect(usageLine(api, local(12)).text).toBe("this week $1.20");
  });

  // Review, 2026-11-22: two windows equally used (both 0% on a fresh plan) showed whichever came first; the one that
  // resets sooner says more.
  it("on a tie, the window that resets sooner", () => {
    const windows = [
      { name: "week", usedPercent: 0, resetsAt: local(9, 5, 25).toISOString() },
      { name: "5 h", usedPercent: 0, resetsAt: local(14, 20).toISOString() },
    ];
    expect(usageLine(usage({ windows }), local(12)).text).toBe("0% of 5 h · resets 14:20");
  });

  it("a reset on another day says the day", () => {
    const windows = [{ name: "week", usedPercent: 81, resetsAt: local(9, 5, 25).toISOString() }];
    expect(usageLine(usage({ windows }), local(12)).text).toBe("81% of week · resets Wed 09:05");
  });
});
