import { afterEach, describe, expect, it } from "vitest";
import { defaultAgent, getHarness, listedHarnessIds } from "./registry.js";

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

// The user, 2026-11-19 ("also build the settings as well… like the general if needed"): `debug` in config lists the
// test agent like ION_DEBUG=1; either one is enough.
describe("debug in config", () => {
  it("lists the test agent without ION_DEBUG", () => {
    process.env.ION_ALLOW_FAKE = "1";
    delete process.env.ION_DEBUG;
    expect(listedHarnessIds(false)).not.toContain("fake");
    expect(listedHarnessIds(true)).toContain("fake");
  });
});
