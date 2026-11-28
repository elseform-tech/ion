import { readFileSync } from "node:fs";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // Alive, only not ours to signal.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

const holder = (file: string): number | null => {
  try {
    const pid = Number(readFileSync(file, "utf8"));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

/**
 * A daemon a test run started (ION_TESTRUN_LEASE: a file in the run's folder holding the runner's pid) calls `lost` once
 * the runner is gone or the run's folder removed, so it never outlives the run (2026-11-23: test daemons left running
 * for days). Your daemon has no lease and is never watched. Returns what stops watching.
 */
export function watchLease(env: NodeJS.ProcessEnv, lost: () => void, everyMs = 1000): () => void {
  const file = env.ION_TESTRUN_LEASE;
  if (!file) return () => {};
  const timer = setInterval(() => {
    const pid = holder(file);
    if (pid !== null && alive(pid)) return;
    clearInterval(timer);
    lost();
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
