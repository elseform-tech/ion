import { DEFAULT_CONFIG, type UserConfig } from "@ion/config";
import type { AgentUsage, NewEvent } from "@ion/schema";
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
  new EventStore(d, allViews).rebuildViews();
  return d;
};

/** Past chats in `default` on opencode, each a short change that took `tokens` in all. */
function past(d: ReturnType<typeof db>, tokens: number[]) {
  const store = new EventStore(d, allViews);
  tokens.forEach((t, i) => {
    const [chatId, runId] = [`c${i}`, `r${i}`];
    const add = (type: string, data: object, origin = "daemon") =>
      store.append({
        chatId,
        runId: type.startsWith("chat") || type === "message.sent" ? null : runId,
        origin,
        type,
        data,
      } as NewEvent);
    add("chat.created", { title: "t", projectId: "default" });
    add("message.sent", { text: "Add a line to notes.md" });
    add("run.started", { harness: "opencode", model: "m", effort: null, authMethod: null }, "adapter");
    add("usage.reported", { model: "m", inputTokens: t - 10, outputTokens: 10, totalTokens: t }, "adapter");
    add("run.finished", { status: "done" });
  });
}

// The user, 2026-11-24: two model settings and the rest automatic. Automatic (Pick by usage, always on) picks a chat's
// agent when none is set: ready, not limited, with room left, free or subscription before pay-per-use, Claude Code
// last unless it's the only one, never one you avoid, along "Prefer in this order" when you set one.
describe("Automatic", () => {
  // Review of fb615b0, 2026-11-23: the estimate it works out for its pick is handed back (the brain pill's hover).
  it("hands back what the request usually takes on the agent it picked", () => {
    const d = db();
    past(d, [1000, 2000, 3000, 4000, 5000]);
    const r = routeBy(DEFAULT_CONFIG, [usage("opencode", "opencode", { billing: "free" })], {
      db: d,
      text: "Add a test",
    });
    expect(r?.estimate).toEqual({ unit: "tokens", low: 3000, high: 5000 });
  });

  it("picks a chat's agent and says why", () => {
    const now = new Date();
    const soon = new Date(now.getTime() + 3600_000).toISOString();
    const list = [
      usage("codex", "Codex", { windows: [{ name: "5h", usedPercent: 91, resetsAt: soon }] }),
      usage("claude-code", "Claude Code"),
      usage("opencode", "opencode", { billing: "free" }),
    ];
    const c = config({ order: ["codex", "opencode"] });
    expect(routeBy(c, list, { db: db(), now })).toEqual({
      harness: "opencode",
      reason: "On opencode — Codex is near its limit",
    });
  });

  it("puts Claude Code last unless it's the only one, and never picks one you avoid", () => {
    const list = [usage("claude-code", "Claude Code"), usage("codex", "Codex", { billing: "api" })];
    expect(routeBy(config({ order: ["claude-code"] }), list, { db: db() })?.harness).toBe("codex");
    expect(routeBy(DEFAULT_CONFIG, [usage("claude-code", "Claude Code")], { db: db() })?.harness).toBe(
      "claude-code",
    );
    const avoid = { agents: { codex: { avoid: true } } };
    expect(routeBy(config({}, avoid), list, { db: db() })?.harness).toBe("claude-code");
  });
});
