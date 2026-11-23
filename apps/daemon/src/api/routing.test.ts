import { DEFAULT_CONFIG, type UserConfig } from "@ion/config";
import type { AgentUsage } from "@ion/schema";
import { describe, expect, it } from "vitest";
import { EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { routeBy } from "./routing.js";

const NONE = { tokens: 0, costUsd: 0 };
const usage = (harness: string, label: string, more: Partial<AgentUsage> = {}): AgentUsage => ({
  ...{ harness, label, billing: "subscription", today: NONE, week: NONE, windows: [], limitedUntil: null },
  ...more,
});
const config = (routing: Partial<UserConfig["routing"]>, more: Partial<UserConfig> = {}): UserConfig => ({
  ...DEFAULT_CONFIG,
  ...more,
  routing: { ...DEFAULT_CONFIG.routing, ...routing },
});
/** A database with ion's views (the store makes them). */
const db = () => {
  const d = openDb(":memory:");
  return new EventStore(d, allViews) && d;
};

describe("Pick by usage", () => {
  // The user, 2026-11-22: Pick by usage is off at first; ion's usual default applies.
  it("is off by default", () => {
    expect(routeBy(DEFAULT_CONFIG, [usage("opencode", "opencode")], { db: db() })).toBeNull();
  });

  // The user, 2026-11-22: on, it fills in a new chat's agent, and the chat says why in one line.
  it("picks a new chat's agent and says why", () => {
    const now = new Date();
    const soon = new Date(now.getTime() + 3600_000).toISOString();
    const list = [
      usage("codex", "Codex", { windows: [{ name: "5h", usedPercent: 91, resetsAt: soon }] }),
      usage("claude-code", "Claude Code"),
      usage("opencode", "opencode", { billing: "free" }),
    ];
    const c = config({ byUsage: true, order: ["codex", "opencode"] });
    expect(routeBy(c, list, { db: db(), now })).toEqual({
      harness: "opencode",
      reason: "On opencode — Codex is near its limit",
    });
  });

  // The user, 2026-11-21: save Claude unless the work needs it (ion's deep model's agent, at Max effort).
  it("keeps ion's deep model's agent for Max effort", () => {
    const list = [usage("claude-code", "Claude Code"), usage("codex", "Codex")];
    const c = config({ byUsage: true, order: ["opencode", "claude-code", "codex"] });
    expect(routeBy(c, list, { db: db() })?.harness).toBe("codex");
    expect(routeBy(c, list, { db: db(), effort: "max" })).toEqual({
      harness: "claude-code",
      reason: "On Claude Code — deep work",
    });
  });

  // Plan 20: a project's own agent is its fit while Pick by usage is on.
  it("puts the project's own agent first", () => {
    const projects = [{ id: "web", path: "/w", starred: false, harness: "codex" }];
    const c = config({ byUsage: true }, { projects });
    const list = [usage("opencode", "opencode"), usage("codex", "Codex")];
    expect(routeBy(c, list, { db: db(), projectId: "web" })).toEqual({
      harness: "codex",
      reason: "On Codex — this project's agent",
    });
  });
});
