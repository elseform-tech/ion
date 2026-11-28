import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempRun } from "./setup.js";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/**
 * A process left running under `home`, as a daemon a test started is: detached, its ION_HOME there. Node, not sleep:
 * macOS never shows a system binary's environment to ps.
 */
const leftUnder = (home: string) => {
  const p = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300_000)"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ION_HOME: home },
  });
  p.unref();
  return p.pid!;
};
const until = async (done: () => boolean) => {
  for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setTimeout(r, 50));
};

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

  // 2026-11-23, the Mac slowed down: ~13 test daemons (ION_HOME=/tmp/ion-test-run-*/ion-cli-*) and their agents were
  // still running after `pnpm check`s, some 1½ days old; the teardown only looked at folders.
  it("fails on a process still running under its folder, and stops it", async () => {
    const end = tempRun(env());
    const pid = leftUnder(join(process.env.TMPDIR!, "ion-cli-x"));
    expect(() => end()).toThrow(/left 1 processes running/);
    await until(() => !alive(pid));
    expect(alive(pid)).toBe(false);
  });

  it("gives the run's daemons a lease: the runner's pid", () => {
    const end = tempRun(env());
    expect(readFileSync(process.env.ION_TESTRUN_LEASE!, "utf8")).toBe(String(process.pid));
    end();
    expect(process.env.ION_TESTRUN_LEASE).toBeUndefined();
  });

  // A run killed mid-way (a timeout, Ctrl+C, a crashed turbo) never runs its teardown: the next run cleans up after it.
  it("stops what a run whose runner died left running, and leaves a live run alone", async () => {
    const o = env();
    const dead = join(o.base, "ion-test-run-dead");
    const live = join(o.base, "ion-test-run-live");
    for (const d of [dead, live]) mkdirSync(d);
    const gone = spawn("true");
    await new Promise((r) => gone.on("exit", r));
    writeFileSync(join(dead, "lease"), String(gone.pid));
    writeFileSync(join(live, "lease"), String(process.pid));
    const orphan = leftUnder(join(dead, "ion-cli-x"));
    const kept = leftUnder(join(live, "ion-cli-x"));
    const end = tempRun(o);
    await until(() => !alive(orphan));
    expect(alive(orphan)).toBe(false);
    expect(existsSync(dead)).toBe(false);
    expect(alive(kept)).toBe(true);
    process.kill(kept, "SIGKILL");
    end();
  });
});
