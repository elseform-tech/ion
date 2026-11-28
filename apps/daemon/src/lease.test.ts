import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { watchLease } from "./lease.js";

const until = async (done: () => boolean) => {
  for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setTimeout(r, 20));
};

// 2026-11-23, the Mac slowed down: test daemons (started detached by `ion daemon start`) outlived the test run that
// started them, some for 1½ days. A daemon a test started holds the run's lease and stops once the runner is gone.
describe("a test daemon's lease", () => {
  const lease = (pid: number) => {
    const f = join(mkdtempSync(join(tmpdir(), "ion-lease-")), "lease");
    writeFileSync(f, String(pid));
    return f;
  };

  it("is lost when the runner that holds it is gone", async () => {
    const runner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"]);
    let lost = 0;
    const stop = watchLease({ ION_TESTRUN_LEASE: lease(runner.pid!) }, () => lost++, 10);
    await new Promise((r) => setTimeout(r, 60));
    expect(lost).toBe(0);
    runner.kill("SIGKILL");
    await until(() => lost > 0);
    expect(lost).toBe(1);
    stop();
  });

  it("is lost when the run's folder is removed", async () => {
    const f = lease(process.pid);
    let lost = 0;
    const stop = watchLease({ ION_TESTRUN_LEASE: f }, () => lost++, 10);
    rmSync(join(f, ".."), { recursive: true });
    await until(() => lost > 0);
    expect(lost).toBe(1);
    stop();
  });

  it("is never watched for a daemon no test started (yours)", () => {
    let lost = 0;
    const stop = watchLease({}, () => lost++, 10);
    expect(lost).toBe(0);
    stop();
  });
});
