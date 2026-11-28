import { describe, expect, it } from "vitest";
import { isRunnersWatchdog } from "./procs.js";

// vitest 5.1.1 (Dependabot #42, 2026-11-28): its own vitest-watchdog was counted as a leak. The runner forks it with
// the run's TMPDIR, and it renames itself to just "vitest-watchdog" (no vitest path in the command).
describe("the runner's own watchdog", () => {
  const runner = 100;
  it("is the process called vitest-watchdog that the runner started", () => {
    expect(isRunnersWatchdog({ pid: 200, ppid: runner, command: "vitest-watchdog" }, runner)).toBe(true);
  });
  it("is not one started by anything else", () => {
    expect(isRunnersWatchdog({ pid: 200, ppid: 1, command: "vitest-watchdog" }, runner)).toBe(false);
  });
  it("is not another process of the runner's, a daemon or an agent a test started", () => {
    expect(isRunnersWatchdog({ pid: 200, ppid: runner, command: "node daemon.js" }, runner)).toBe(false);
    expect(isRunnersWatchdog({ pid: 200, ppid: runner, command: "vitest-watchdog --x" }, runner)).toBe(false);
  });
});
