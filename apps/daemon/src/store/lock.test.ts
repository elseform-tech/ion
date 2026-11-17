import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireDaemonLock } from "./lock.js";

// Regression (final review C2): the pid-file lock let two daemons run on one data folder.
describe("acquireDaemonLock", () => {
  it("lets only one holder at a time, and frees on release", () => {
    const dir = mkdtempSync(join(tmpdir(), "ion-lock-"));
    const a = acquireDaemonLock(dir);
    expect(a).not.toBeNull();
    expect(acquireDaemonLock(dir)).toBeNull();
    a?.release();
    const b = acquireDaemonLock(dir);
    expect(b).not.toBeNull();
    b?.release();
  });

  it("recovers from a leftover lock file that isn't a lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "ion-lock-"));
    writeFileSync(join(dir, "daemon.lock"), "12345");
    const a = acquireDaemonLock(dir);
    expect(a).not.toBeNull();
    a?.release();
  });
});
