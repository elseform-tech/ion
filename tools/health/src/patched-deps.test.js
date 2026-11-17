import { readFileSync } from "node:fs";
import picomatch from "picomatch";
import { describe, expect, it } from "vitest";
import { unpatched } from "./lockfile.js";

const timed = (fn) => {
  const t = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t };
};

// Regression: GHSA-fc5q-39xc-vjpf (picomatch <=4.0.7 ReDoS, no upstream fix yet).
// patches/picomatch@4.0.7.patch marks repeated extglobs whose branch contains `*` as risky.
describe("picomatch patch", () => {
  it.each(["+(*a)", "*(*a)", "+(*)"])("%s is treated as literal text and finishes quickly", (glob) => {
    // The patch's effect, independent of machine speed: the risky pattern only matches itself.
    expect(picomatch.isMatch(glob, glob)).toBe(true);
    // Unpatched, this input takes seconds (exponential backtracking); 1 s leaves room for slow CI runners.
    const { value, ms } = timed(() => picomatch.makeRe(glob).test(`${"a".repeat(26)}!`));
    expect(value).toBe(false);
    expect(ms).toBeLessThan(1000);
  });

  it("keeps the safe rewrites and normal extglobs working", () => {
    expect(String(picomatch.makeRe("+(*(a)|*(b))"))).toContain("[ab]*");
    expect(picomatch.isMatch("ab", "+(a|b)")).toBe(true);
    expect(picomatch.isMatch("src/x.ts", "src/*.ts")).toBe(true);
    expect(picomatch.isMatch("a/b/c.js", "**/*.js")).toBe(true);
  });
});

// The dependency-review waiver for GHSA-fc5q-39xc-vjpf is only safe while every resolved copy is patched.
describe("lockfile guard", () => {
  const HASH = "abc123";
  const lock = (snapshots, hash = HASH) =>
    `lockfileVersion: '9.0'\npatchedDependencies:\n  picomatch@4.0.7:\n    hash: ${hash}\n    path: x.patch\npackages:\n  picomatch@4.0.7:\n    resolution: {integrity: x}\nsnapshots:\n${snapshots}`;
  const ok = `  picomatch@4.0.7(patch_hash=${HASH}): {}\n  fdir@6.5.0:\n    dependencies:\n      picomatch: 4.0.7(patch_hash=${HASH})\n`;

  it("passes when every resolved copy carries the declared patch", () => {
    expect(unpatched(lock(ok), "picomatch")).toEqual([]);
  });

  it("flags unpatched, wrongly hashed and quoted copies", () => {
    const bad = `${ok}  picomatch@2.3.1: {}\n  a@1.0.0:\n    dependencies:\n      picomatch: 4.0.7(patch_hash=evil)\n  b@1.0.0:\n    dependencies:\n      picomatch: '4.0.6'\n`;
    expect(unpatched(lock(bad), "picomatch")).toEqual([
      "picomatch@2.3.1",
      "a@1.0.0 → picomatch 4.0.7(patch_hash=evil)",
      "b@1.0.0 → picomatch 4.0.6",
    ]);
  });

  it("fails closed when there's nothing to check", () => {
    expect(() => unpatched("lockfileVersion: '9.0'\n", "picomatch")).toThrow(/no snapshots/);
    expect(() => unpatched(lock("  other@1.0.0: {}\n"), "picomatch")).toThrow(/no picomatch/);
  });

  it("finds nothing unpatched in the real lockfile", () => {
    expect(
      unpatched(readFileSync(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8"), "picomatch"),
    ).toEqual([]);
  });
});
