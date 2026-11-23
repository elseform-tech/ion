import { describe, expect, it } from "vitest";
import { type Candidate, pickAgent, type Task } from "./route.js";

const NOW = new Date("2026-11-23T12:00:00Z");
const later = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();

const agent = (id: string, more: Partial<Candidate> = {}): Candidate => ({
  id,
  label: { opencode: "opencode", grok: "Grok Build", codex: "Codex", claude: "Claude Code" }[id] ?? id,
  billing: "subscription",
  windows: [],
  limitedUntil: null,
  ...more,
});

const ORDER = ["opencode", "grok", "codex", "claude"];
const task = (more: Partial<Task> = {}): Task => ({ order: ORDER, now: NOW, ...more });

describe("pickAgent", () => {
  // The user, 2026-11-21: a limited agent is never picked (its limit is learned from its errors).
  it("a limited agent is never picked", () => {
    const r = pickAgent([agent("opencode", { limitedUntil: later(30) }), agent("grok")], task());
    expect(r).toEqual({ agent: "grok", reason: "On Grok Build — opencode hit its limit" });
    expect(pickAgent([agent("opencode", { limitedUntil: later(30) })], task())).toEqual({
      agent: null,
      reason: "No agent is free",
    });
  });

  // The user, 2026-11-23 ("verify, don't guess"): a limit that was only ion's guess may be over: it's tried, last.
  it("an agent limited only by ion's guess is tried after the free ones", () => {
    const guessed = agent("opencode", { limitedUntil: later(30), limitGuessed: true });
    expect(pickAgent([guessed, agent("codex")], task()).agent).toBe("codex");
    expect(pickAgent([guessed], task()).agent).toBe("opencode");
  });

  // The user, 2026-11-21: save Claude quota; Claude only when needed (ion's deep model's agent is kept for deep work).
  it("Claude is saved unless deep work needs it", () => {
    const all = [agent("claude"), agent("codex")];
    const order = ["opencode", "claude", "codex"];
    expect(pickAgent(all, task({ order, deepAgent: "claude" }))).toEqual({
      agent: "codex",
      reason: "On Codex — Claude Code is kept for deep work",
    });
    expect(pickAgent(all, task({ order, deepAgent: "claude", deep: true }))).toEqual({
      agent: "claude",
      reason: "On Claude Code — deep work",
    });
  });

  // Review of bf69fe1, 2026-11-23: you put Claude Code first in your order on purpose; it isn't held back.
  it("the deep model's agent first in your order isn't held back", () => {
    const all = [agent("claude"), agent("codex")];
    expect(pickAgent(all, task({ order: ["claude", "codex"], deepAgent: "claude" }))).toEqual({
      agent: "claude",
      reason: "On Claude Code — first in your order",
    });
  });

  // The user, 2026-11-21: headroom from the windows an agent reports (Codex's 5 h and weekly).
  it("near a window's end, another agent is picked", () => {
    const near = agent("codex", { windows: [{ name: "5h", usedPercent: 92, resetsAt: later(60) }] });
    const r = pickAgent([near, agent("claude")], task({ order: ["codex", "claude"] }));
    expect(r).toEqual({ agent: "claude", reason: "On Claude Code — Codex is near its limit" });
    // A window already past its reset says nothing about now.
    const old = agent("codex", { windows: [{ name: "5h", usedPercent: 99, resetsAt: later(-5) }] });
    expect(pickAgent([old, agent("claude")], task({ order: ["codex", "claude"] })).agent).toBe("codex");
  });

  // Plan 20's constraint: subscription and free before api (paid per token).
  it("api-billed comes after subscription and free", () => {
    const r = pickAgent(
      [agent("claude", { billing: "api" }), agent("codex")],
      task({ order: ["claude", "codex"] }),
    );
    expect(r).toEqual({ agent: "codex", reason: "On Codex — Claude Code is paid per use" });
    expect(pickAgent([agent("opencode", { billing: "free" })], task())).toEqual({
      agent: "opencode",
      reason: "On opencode — free and enough for this",
    });
  });

  // The user, 2026-11-21: routing never overrides an agent you picked; it only fills in when nothing was.
  it("your pick always wins", () => {
    const limited = agent("claude", { limitedUntil: later(30), billing: "api" });
    expect(pickAgent([limited, agent("opencode")], task({ picked: "claude" }))).toEqual({
      agent: "claude",
      reason: null,
    });
  });

  // The user, 2026-11-22: one agent order (Settings → Agents) decides handoff targets and routing.
  it("the agent order decides handoff targets and routing", () => {
    const all = [agent("opencode"), agent("grok"), agent("codex")];
    expect(pickAgent(all, task({ order: ["codex", "grok", "opencode"] }))).toEqual({
      agent: "codex",
      reason: "On Codex — first in your order",
    });
    expect(pickAgent(all, task({ order: ["grok"] })).agent).toBe("grok");
  });

  it("a project's own agent fits first", () => {
    const all = [agent("opencode"), agent("codex")];
    expect(pickAgent(all, task({ project: "codex" }))).toEqual({
      agent: "codex",
      reason: "On Codex — this project's agent",
    });
  });
  // The user, 2026-11-22: a task that usually takes more of an agent's window than it has left goes on another.
  it("a task that won't fit what's left of an agent's window goes on another", () => {
    const codex = agent("codex", { windows: [{ name: "5 h", usedPercent: 70, resetsAt: later(60) }] });
    const order = ["codex", "claude"];
    const estimate = { codex: { unit: "percent" as const, low: 20, high: 40, window: "5 h" } };
    expect(pickAgent([codex, agent("claude")], task({ order, estimate }))).toEqual({
      agent: "claude",
      reason: "On Claude Code — Codex has too little left for this",
    });
    // One that fits stays put.
    const small = { codex: { unit: "percent" as const, low: 5, high: 10, window: "5 h" } };
    expect(pickAgent([codex, agent("claude")], task({ order, estimate: small })).agent).toBe("codex");
  });
});
