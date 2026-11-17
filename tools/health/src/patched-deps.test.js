import picomatch from "picomatch";
import { describe, expect, it } from "vitest";

const timed = (fn) => {
  const t = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t };
};

// Regression: GHSA-fc5q-39xc-vjpf (picomatch <=4.0.7 ReDoS, no upstream fix yet).
// patches/picomatch@4.0.7.patch marks repeated extglobs whose branch contains `*` as risky.
describe("picomatch patch", () => {
  it.each(["+(*a)", "*(*a)", "+(*)"])("%s finishes quickly on a crafted string", (glob) => {
    const { value, ms } = timed(() => picomatch.makeRe(glob).test(`${"a".repeat(26)}!`));
    expect(value).toBe(false);
    expect(ms).toBeLessThan(200);
  });

  it("keeps the safe rewrites and normal extglobs working", () => {
    expect(String(picomatch.makeRe("+(*(a)|*(b))"))).toContain("[ab]*");
    expect(picomatch.isMatch("ab", "+(a|b)")).toBe(true);
    expect(picomatch.isMatch("src/x.ts", "src/*.ts")).toBe(true);
    expect(picomatch.isMatch("a/b/c.js", "**/*.js")).toBe(true);
  });
});
