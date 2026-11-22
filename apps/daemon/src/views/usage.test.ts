import type { NewEvent } from "@ion/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "./index.js";
import { usageView } from "./usage.js";

let db: Db;
let store: EventStore;
const MIN = 60_000;

beforeEach(() => {
  db = openDb(":memory:");
  store = new EventStore(db, allViews);
});

const append = (runId: string, type: string, data: Record<string, unknown>, origin = "adapter") =>
  store.append({ chatId: `c-${runId}`, runId, origin, type, data } as NewEvent);
const start = (runId: string, harness: string) =>
  append(runId, "run.started", { harness, model: "m", effort: null, authMethod: null });
const limitError = (runId: string, resetsAt?: string) =>
  append(runId, "error", {
    code: "usage_limit",
    retryable: false,
    message: "Limit reached",
    limit: resetsAt ? { resetsAt } : {},
  });
const agent = (harness: string, now = new Date()) => usageView.agents(db, now)[harness];

describe("usageView", () => {
  it("adds up each agent's tokens and cost today and over 7 days", () => {
    start("r1", "claude-code");
    append("r1", "usage.reported", { model: "m", inputTokens: 100, outputTokens: 20, costUsd: 0.5 });
    start("r2", "claude-code");
    append("r2", "usage.reported", { model: "m", inputTokens: 10, outputTokens: 5, costUsd: null });
    expect(agent("claude-code")).toMatchObject({
      today: { tokens: 135, costUsd: 0.5 },
      week: { tokens: 135, costUsd: 0.5 },
    });
  });

  // The user, 2026-11-21: Codex's own windows, kept and shown ("Codex · 62% of 5 h · resets 14:20").
  it("a Codex window snapshot is stored and shown", () => {
    const resetsAt = new Date(Date.now() + 90 * MIN).toISOString();
    const windows = [{ name: "5 h", usedPercent: 62, resetsAt }];
    start("r1", "codex");
    append("r1", "usage.reported", { model: "m", inputTokens: 1, outputTokens: 1, costUsd: null, windows });
    expect(agent("codex")?.windows).toEqual(windows);
  });

  // The user, 2026-11-21: "Claude Code · limited until 16:00".
  it("a limit error marks the agent limited until its reset", () => {
    const resetsAt = new Date(Date.now() + 120 * MIN).toISOString();
    start("r1", "claude-code");
    limitError("r1", resetsAt);
    expect(agent("claude-code")?.limitedUntil).toBe(resetsAt);
    // A run that ends well afterwards (it got past its limit) clears it.
    start("r2", "claude-code");
    append("r2", "run.finished", { status: "done" }, "daemon");
    expect(agent("claude-code")?.limitedUntil).toBeNull();
  });

  // The user, 2026-11-21: a limit that says no reset → a cautious 30 minutes, then the agent is tried once more.
  it("no reset → limited for 30 min, then one retry", () => {
    start("r1", "opencode");
    limitError("r1");
    const until = Date.parse(agent("opencode")!.limitedUntil!);
    expect(until - Date.now()).toBeGreaterThan(29 * MIN);
    expect(until - Date.now()).toBeLessThanOrEqual(30 * MIN);
    // Past the 30 minutes it isn't limited: its next run is the one retry.
    expect(agent("opencode", new Date(Date.now() + 31 * MIN))?.limitedUntil).toBeNull();
  });

  // Review focus 3: two threads hitting one agent's limit at once make one mark, not two (nor a longer one).
  it("two threads on one limit make one mark", () => {
    start("r1", "opencode");
    start("r2", "opencode");
    limitError("r1");
    const first = agent("opencode")!.limitedUntil;
    limitError("r2");
    expect(agent("opencode")!.limitedUntil).toBe(first);
    expect(Object.keys(usageView.agents(db, new Date()))).toEqual(["opencode"]);
  });

  // The user, 2026-11-21: a gauge the agent stopped reporting goes away (never frozen at an old value).
  it("a missing gauge shows Learned from errors", () => {
    const resetsAt = new Date(Date.now() + 90 * MIN).toISOString();
    start("r1", "codex");
    const windows = [{ name: "5 h", usedPercent: 62, resetsAt }];
    append("r1", "usage.reported", { model: "m", inputTokens: 1, outputTokens: 1, windows });
    start("r2", "codex");
    append("r2", "usage.reported", { model: "m", inputTokens: 1, outputTokens: 1 });
    expect(agent("codex")?.windows).toEqual([]);
  });

  // The user, 2026-11-22: ions' spending (ion chief, project ions, the judge, the dream) counts in the agent's line,
  // and their limits mark the agent too: their events name the agent, with no chat's run behind them.
  it("an ion turn's usage and limit count for its agent", () => {
    const ion = (type: string, data: Record<string, unknown>) =>
      store.append({ chatId: null, runId: "turn_1", origin: "adapter", type, data } as NewEvent);
    ion("usage.reported", {
      model: "m",
      inputTokens: 40,
      outputTokens: 2,
      costUsd: 0.1,
      harness: "grok-build",
    });
    const resetsAt = new Date(Date.now() + 60 * MIN).toISOString();
    ion("error", {
      code: "usage_limit",
      retryable: false,
      message: "x",
      limit: { resetsAt },
      harness: "grok-build",
    });
    expect(agent("grok-build")).toMatchObject({ week: { tokens: 42, costUsd: 0.1 }, limitedUntil: resetsAt });
  });

  // Review, 2026-11-22: only a chat's run cleared a mark early; an ion's turn (or the judge) that started after the mark
  // and ended well shows the agent is past its limit too. One that started before it doesn't.
  it("a successful ion turn started after the mark clears it", () => {
    const ion = (type: string, data: Record<string, unknown>) =>
      store.append({ chatId: null, runId: "turn_1", origin: "adapter", type, data } as NewEvent);
    const before = new Date(Date.now() - MIN).toISOString();
    ion("error", { code: "usage_limit", retryable: false, message: "x", limit: {}, harness: "grok-build" });
    ion("run.finished", { status: "done", harness: "grok-build", startedAt: before });
    expect(agent("grok-build")?.limitedUntil).not.toBeNull();
    ion("run.finished", {
      status: "done",
      harness: "grok-build",
      startedAt: new Date(Date.now() + 1000).toISOString(),
    });
    expect(agent("grok-build")?.limitedUntil).toBeNull();
  });

  // Re-review, 2026-11-22: how an agent bills follows the models it really ran this week.
  it("keeps the models each agent ran this week", () => {
    start("r1", "opencode");
    append("r1", "usage.reported", { model: "opencode/big-pickle", inputTokens: 1, outputTokens: 1 });
    start("r2", "opencode");
    append("r2", "usage.reported", { model: "opencode-go/glm-5.3", inputTokens: 1, outputTokens: 1 });
    append("r2", "usage.reported", { model: "opencode-go/glm-5.3", inputTokens: 1, outputTokens: 1 });
    expect(agent("opencode")?.models).toEqual(["opencode-go/glm-5.3", "opencode/big-pickle"]);
  });
});
