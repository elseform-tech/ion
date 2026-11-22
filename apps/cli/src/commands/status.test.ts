import type { AgentUsage } from "@ion/schema";
import { describe, expect, it } from "vitest";
import { agentLines } from "./status.js";

const none = { tokens: 0, costUsd: 0 };
const usage = (harness: string, label: string, u: Partial<AgentUsage> = {}): AgentUsage => ({
  harness,
  label,
  billing: null,
  today: none,
  week: none,
  windows: [],
  limitedUntil: null,
  ...u,
});
const local = (h: number, m = 0) => new Date(2026, 10, 21, h, m);

// The user, 2026-11-21: `ion status` shows each agent's usage in one line, the same as Settings → Agents.
describe("ion status: one line per agent", () => {
  it("a Codex window snapshot is stored and shown", () => {
    const windows = [{ name: "5 h", usedPercent: 62, resetsAt: local(14, 20).toISOString() }];
    expect(agentLines([usage("codex", "Codex", { windows })], local(12))).toEqual([
      "Codex · 62% of 5 h · resets 14:20",
    ]);
  });

  it("a limit error marks the agent limited until its reset", () => {
    const u = usage("claude-code", "Claude Code", { limitedUntil: local(16).toISOString() });
    expect(agentLines([u], local(12))).toEqual(["Claude Code · limited until 16:00"]);
  });

  it("billing comes from the sign-in, and a missing gauge shows Learned from errors", () => {
    const list = [
      usage("opencode", "opencode", { billing: "free" }),
      usage("grok-build", "Grok Build", { billing: "subscription" }),
    ];
    expect(agentLines(list, local(12))).toEqual(["opencode · Free", "Grok Build · Learned from errors"]);
  });
});
