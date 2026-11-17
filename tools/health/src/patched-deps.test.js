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

// The dependency-review waiver for GHSA-fc5q-39xc-vjpf is only safe while every resolved copy is patched.
describe("lockfile guard", () => {
  const lock = (snapshots) =>
    `patchedDependencies:\n  picomatch@4.0.7:\n    hash: abc\n\npackages:\n\n  picomatch@4.0.7:\n    resolution: {}\n\nsnapshots:\n${snapshots}`;

  it("passes when every resolved picomatch carries the patch", () => {
    expect(
      unpatched(
        lock("  picomatch@4.0.7(patch_hash=abc): {}\n      picomatch: 4.0.7(patch_hash=abc)\n"),
        "picomatch",
      ),
    ).toEqual([]);
  });

  it("flags an unpatched copy anywhere in snapshots", () => {
    expect(
      unpatched(
        lock("  picomatch@2.3.1: {}\n      picomatch: 4.0.7(patch_hash=abc)\n      picomatch: 4.0.6\n"),
        "picomatch",
      ),
    ).toEqual(["picomatch@2.3.1", "picomatch: 4.0.6"]);
  });

  it("finds nothing unpatched in the real lockfile", () => {
    expect(
      unpatched(readFileSync(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8"), "picomatch"),
    ).toEqual([]);
  });
});
