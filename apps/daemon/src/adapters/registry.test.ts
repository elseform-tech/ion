import { afterEach, describe, expect, it } from "vitest";
import { getHarness, listedHarnessIds } from "./registry.js";

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
