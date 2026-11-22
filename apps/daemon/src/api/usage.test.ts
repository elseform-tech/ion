import type { HarnessInfo } from "@ion/schema";
import { describe, expect, it } from "vitest";
import { agentUsages } from "./usage.js";

const info = (id: string, more: Partial<HarnessInfo> = {}): HarnessInfo => ({
  id,
  label: id,
  installed: true,
  signedIn: true,
  models: [],
  defaultModel: null,
  ...more,
});

describe("agentUsages", () => {
  // The user, 2026-11-21: how an agent bills comes from its sign-in; one ion can't tell is unknown, never free.
  it("billing comes from the sign-in", () => {
    const list = agentUsages([info("opencode", { billing: "free" }), info("grok-build")], {});
    expect(list.map((u) => [u.harness, u.billing])).toEqual([
      ["opencode", "free"],
      ["grok-build", null],
    ]);
  });

  it("each agent with what the ledger knows of it, and nothing made up for the rest", () => {
    const rows = {
      codex: {
        today: { tokens: 10, costUsd: 0 },
        week: { tokens: 30, costUsd: 0 },
        windows: [{ name: "5 h", usedPercent: 62, resetsAt: null }],
        limitedUntil: null,
      },
    };
    const [codex, claude] = agentUsages([info("codex"), info("claude-code", { label: "Claude Code" })], rows);
    expect(codex).toMatchObject({ harness: "codex", week: { tokens: 30 }, windows: rows.codex.windows });
    expect(claude).toEqual({
      harness: "claude-code",
      label: "Claude Code",
      billing: null,
      today: { tokens: 0, costUsd: 0 },
      week: { tokens: 0, costUsd: 0 },
      windows: [],
      limitedUntil: null,
    });
  });
});
