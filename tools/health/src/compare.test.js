import { describe, expect, it } from "vitest";
import { compareHealth } from "./compare.js";

const base = {
  filesOver400: 1,
  functionsOver50: 2,
  complexityOver10: 3,
  duplicationPct: 1.5,
  eslintDisables: 0,
  todos: 4,
};

describe("compareHealth", () => {
  it("passes when nothing got worse", () => {
    expect(compareHealth(base, { ...base })).toEqual({ ok: true, worse: [], better: [] });
  });
  it("fails and names each metric that got worse", () => {
    const r = compareHealth(base, { ...base, functionsOver50: 3, duplicationPct: 2 });
    expect(r.ok).toBe(false);
    expect(r.worse).toEqual([
      { metric: "functionsOver50", was: 2, now: 3 },
      { metric: "duplicationPct", was: 1.5, now: 2 },
    ]);
  });
  it("reports improvements so the baseline can be tightened", () => {
    expect(compareHealth(base, { ...base, todos: 1 }).better).toEqual([{ metric: "todos", was: 4, now: 1 }]);
  });
  it("treats a metric missing from the baseline as zero", () => {
    expect(compareHealth({}, { todos: 1 }).worse).toEqual([{ metric: "todos", was: 0, now: 1 }]);
  });
  it("ignores float noise in duplication", () => {
    expect(compareHealth({ duplicationPct: 1.5 }, { duplicationPct: 1.5000001 }).ok).toBe(true);
  });
});
