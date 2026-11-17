import { describe, expect, it } from "vitest";
import { backoffDelay, MAX_TRIES, nextEffort, retryPlan } from "./retry.js";

/** A small seeded generator (mulberry32), so the draws are the same every run. */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe("backoffDelay", () => {
  it("stays within random(0, min(120, 2 × 2^attempt)) over 1,000 seeded draws", () => {
    const random = seeded(42);
    for (let i = 0; i < 1000; i++) {
      const attempt = 1 + (i % 8);
      const d = backoffDelay(attempt, random);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(Math.min(120, 2 * 2 ** attempt));
    }
  });

  it("uses the error's retry-after when there is one", () => {
    expect(backoffDelay(1, () => 0.5, 30)).toBe(30);
  });

  // Final review minors 5: a harness's retry-after is capped at 120 s; a nonsense one is ignored.
  it("caps a retry-after at 120 s and ignores one that isn't a number", () => {
    expect(backoffDelay(1, () => 0.5, 3600)).toBe(120);
    expect(backoffDelay(1, () => 0.5, -5)).toBe(0);
    expect(backoffDelay(1, () => 0.5, Number.NaN)).toBe(2);
  });
});

describe("nextEffort", () => {
  it("steps up one level and never above max", () => {
    expect(nextEffort("low")).toBe("medium");
    expect(nextEffort("medium")).toBe("high");
    expect(nextEffort("high")).toBe("max");
    expect(nextEffort("max")).toBeNull();
  });
});

describe("retryPlan", () => {
  const transient = { code: "rate_limit", retryable: true, message: "Slow down" };
  const real = { code: "agent", retryable: false, message: "Couldn't do it" };

  it("retries a transient failure until the last of 4 tries", () => {
    expect(retryPlan({ tries: 1, effortRetried: false, effort: null }, transient, () => 0)).toMatchObject({
      attempt: 1,
      delayS: 0,
      effort: null,
    });
    expect(
      retryPlan({ tries: MAX_TRIES, effortRetried: false, effort: null }, transient, () => 0),
    ).toBeNull();
    expect(MAX_TRIES).toBe(4);
  });

  it("retries a real failure once, one effort level higher", () => {
    expect(retryPlan({ tries: 1, effortRetried: false, effort: "high" }, real, () => 0)).toMatchObject({
      effort: "max",
      delayS: 0,
    });
    expect(retryPlan({ tries: 2, effortRetried: true, effort: "max" }, real, () => 0)).toBeNull();
    expect(retryPlan({ tries: 1, effortRetried: false, effort: "max" }, real, () => 0)).toBeNull();
  });

  it("doesn't retry account or usage-limit failures at a higher effort; it wouldn't help", () => {
    for (const code of [
      "usage_limit",
      "billing_error",
      "authentication_failed",
      "model_not_found",
      "error_max_budget_usd",
      "error_max_turns",
    ])
      expect(
        retryPlan(
          { tries: 1, effortRetried: false, effort: "low" },
          { code, retryable: false, message: "x" },
          () => 0,
        ),
      ).toBeNull();
  });

  it("doesn't retry a run that ended without an error", () => {
    expect(retryPlan({ tries: 1, effortRetried: false, effort: null }, null, () => 0)).toBeNull();
  });
});
