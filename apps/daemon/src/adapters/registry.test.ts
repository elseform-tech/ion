import { afterEach, describe, expect, it } from "vitest";
import { agentOrder, byPreference, defaultAgent, getHarness, listedHarnessIds } from "./registry.js";

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

// The user, 2026-11-19: the fake agent showed in the app's agent pickers. It's for tests and the tour only; the app
// lists it in debug mode (ION_DEBUG=1).
describe("the agents ion lists", () => {
  it("leaves out the fake agent, which still runs for tests and the tour", () => {
    process.env.ION_ALLOW_FAKE = "1";
    delete process.env.ION_DEBUG;
    expect(listedHarnessIds()).not.toContain("fake");
    expect(listedHarnessIds()).toContain("opencode");
    expect(getHarness("fake")).not.toBeNull();
  });

  it("lists it in debug mode", () => {
    process.env.ION_ALLOW_FAKE = "1";
    process.env.ION_DEBUG = "1";
    expect(listedHarnessIds()).toContain("fake");
  });
});

// The user, 2026-11-19: only a ready agent is a default; `ion ask` without --harness always meant Claude Code.
describe("the default agent", () => {
  it("is the chat's own while it's ready, else the first ready (quota-friendly first)", () => {
    expect(defaultAgent(["claude-code", "grok-build"], "claude-code")).toBe("claude-code");
    expect(defaultAgent(["claude-code", "grok-build"], "opencode")).toBe("grok-build");
    expect(defaultAgent(["claude-code", "opencode"], null)).toBe("opencode");
    expect(defaultAgent([], null)).toBeUndefined();
  });
});

// The user, 2026-11-22: one agent order (Settings → Agents, default opencode, Grok Build, Codex, Claude Code) replaces
// the order fixed in code: it decides handoff targets, routing, and an ion's chats when the project names none.
describe("the agent order", () => {
  it("the agent order decides handoff targets and routing", () => {
    const order = agentOrder(["codex", "nope", "opencode"]);
    expect(order).toEqual(["codex", "opencode", "grok-build", "claude-code"]);
    expect(agentOrder([])).toEqual(["opencode", "grok-build", "codex", "claude-code"]);
    expect(byPreference(["claude-code", "opencode", "codex"], order)).toEqual([
      "codex",
      "opencode",
      "claude-code",
    ]);
    expect(defaultAgent(["claude-code", "opencode", "codex"], null, order)).toBe("codex");
    expect(defaultAgent(["claude-code", "opencode"], "claude-code", order)).toBe("claude-code");
  });
});
