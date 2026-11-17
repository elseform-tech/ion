import { rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

type Lock = { release(): void };

function tryLock(file: string): Lock | "busy" | "broken" {
  const db = new Database(file);
  try {
    db.pragma("busy_timeout = 0");
    db.pragma("locking_mode = EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE");
  } catch (e) {
    db.close();
    return (e as { code?: string }).code === "SQLITE_BUSY" ? "busy" : "broken";
  }
  return {
    release() {
      try {
        db.exec("COMMIT");
      } finally {
        db.close();
      }
    },
  };
}

/**
 * One daemon per data folder. Holds an exclusive SQLite lock on `daemon.lock` for the process's life.
 * The OS drops the lock when the process dies, so there's no stale pid to trust or take over.
 * Two daemons starting at the same instant can both see "busy"; a few jittered retries let one win.
 */
export function acquireDaemonLock(dataDir: string, attempts = 6): Lock | null {
  const file = join(dataDir, "daemon.lock");
  let replaced = false;
  for (let i = 0; i < attempts; i++) {
    const r = tryLock(file);
    if (r !== "busy" && r !== "broken") return r;
    if (r === "broken" && !replaced) {
      rmSync(file, { force: true }); // e.g. a leftover non-database file
      replaced = true;
      continue;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 + Math.random() * 80);
  }
  return null;
}
