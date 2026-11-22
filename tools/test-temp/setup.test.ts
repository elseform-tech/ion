import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempRun } from "./setup.js";

// CI (ubuntu), PR #25, 2026-11-22: "Tests left 4 folders in /tmp: ion-test-run-…". turbo runs packages' tests at once,
// so one run's teardown saw the other runs' own folders. A run checks only the folder it made (gone) and new ion-*
// leftovers that aren't another run's folder.
describe("a test run's temp folder", () => {
  const env = () => {
    const real = mkdtempSync(join(tmpdir(), "tt-real-"));
    return { real, base: real };
  };

  it("doesn't fail on another run's folder made while it ran, and removes its own", () => {
    const o = env();
    const end = tempRun(o);
    const mine = process.env.TMPDIR;
    mkdirSync(join(o.real, "ion-test-run-other"));
    end();
    expect(existsSync(mine)).toBe(false);
    expect(process.env.TMPDIR).not.toBe(mine);
  });

  it("still fails on another ion-* folder left in the real temp folder", () => {
    const o = env();
    const end = tempRun(o);
    mkdirSync(join(o.real, "ion-probe-left"));
    expect(() => end()).toThrow(/ion-probe-left/);
  });
});
