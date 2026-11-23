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

describe("Pick by usage", () => {
  // Review of fb615b0, 2026-11-23: the estimate Pick by usage works out for its pick is handed back (the brain
  // pill's hover uses it), not worked out a second time.
  it("hands back what the request usually takes on the agent it picked", () => {
    const d = db();
    past(d, [1000, 2000, 3000, 4000, 5000]);
    const c = config({ byUsage: true });
    const r = routeBy(c, [usage("opencode", "opencode", { billing: "free" })], { db: d, text: "Add a test" });
    expect(r?.estimate).toEqual({ unit: "tokens", low: 3000, high: 5000 });
  });

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

  // Plan 20: a project's own agent is its fit for its ion's threads while Pick by usage is on.
  it("puts the project's own agent first for its ion's threads", () => {
    const projects = [{ id: "web", path: "/w", starred: false, harness: "codex" }];
    const c = config({ byUsage: true }, { projects });
    const list = [usage("opencode", "opencode"), usage("codex", "Codex")];
    expect(routeBy(c, list, { db: db(), projectId: "web", thread: true })).toEqual({
      harness: "codex",
      reason: "On Codex — this project's agent",
    });
  });

  // Final review, 2026-11-23 (the user's ruling): your own new chats follow your agent order, not the project's agent.
  it("your new chat goes by your order, whatever the project's agent", () => {
    const projects = [{ id: "web", path: "/w", starred: false, harness: "claude-code" }];
    const c = config({ byUsage: true, order: ["opencode", "claude-code"] }, { projects });
    const list = [usage("opencode", "opencode"), usage("claude-code", "Claude Code")];
    expect(routeBy(c, list, { db: db(), projectId: "web" })?.harness).toBe("opencode");
  });
});
