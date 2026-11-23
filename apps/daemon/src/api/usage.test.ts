import type { HarnessInfo } from "@ion/schema";
import { describe, expect, it } from "vitest";
import { agentUsages, billings } from "./usage.js";

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

// Re-review, 2026-11-22: opencode showed Free from ion's default model, even after ion ran a paid opencode model
// (its quick model, a project's, a chat's). How it bills comes from the models it really ran this week, else the ones
// ion is set to run on it (null: its default), asked of the agent itself.
describe("billings", () => {
  const priced = async (models: (string | null)[]) =>
    models.every((m) => m === null || m.endsWith("-free")) ? ("free" as const) : undefined;
  const opencode = { id: "opencode", billingOf: priced };
  it("a paid model over a free default isn't Free", async () => {
    expect(await billings([opencode], { opencode: ["opencode/x-free"] }, () => [null])).toEqual({
      opencode: "free",
    });
    expect(
      await billings([opencode], { opencode: ["opencode/x-free", "opencode-go/paid"] }, () => [null]),
    ).toEqual({
      opencode: null,
    });
  });
  it("with nothing run, the models ion is set to run on it", async () => {
    expect(await billings([opencode], {}, () => [null, "opencode-go/paid"])).toEqual({ opencode: null });
    expect(await billings([opencode], {}, () => [null])).toEqual({ opencode: "free" });
  });
  it("an agent that can't say keeps its sign-in's", async () => {
    expect(await billings([{ id: "codex" }], {}, () => [null])).toEqual({});
  });
});
