import { spawn } from "node:child_process";
import { mkdirSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, type DaemonInfo, type IonClient, readDaemonInfo } from "@ion/client";

const DAEMON =
  process.env.ION_DAEMON_BIN ?? fileURLToPath(new URL("../../daemon/dist/main.js", import.meta.url));

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const killGroup = (pid: number) => {
  for (const target of [-pid, pid])
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // gone, or no group of its own
    }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The promise, or a timeout error after 1 s. The timer is cleared once it settles (task review, 2026-11-22: a timer
 * left running held every connected command open for a second after it was done).
 */
async function within<T>(p: Promise<T>, ms = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A connected client when ion is up: daemon.json's pid is alive, the token works, and the daemon reports
 * that same pid. A reused pid or an unrelated process never passes. Inside a chat's run, `reachRun` instead.
 */
export async function reach(dataDir: string): Promise<{ client: IonClient; info: DaemonInfo } | null> {
  const info = readDaemonInfo(dataDir);
  if (!info || !isAlive(info.pid)) return null;
  let client: IonClient | undefined;
  try {
    client = await within(connect(info));
    const s = await within(client.call("status", {}));
    if (s.pid !== info.pid) throw new Error("pid mismatch");
    return { client, info };
  } catch {
    client?.close();
    return null;
  }
}

/**
 * Inside a chat's run: ion reached with only its port (ION_PORT) and the run's key, never daemon.json, which the
 * run's sandbox keeps out of reach (Plan 18 Task 12). Null when it doesn't answer.
 */
export async function reachRun(port: string | undefined, runKey: string): Promise<IonClient | null> {
  const n = Number(port);
  if (!Number.isInteger(n) || n <= 0) return null;
  let client: IonClient | undefined;
  try {
    // The key is checked as the connection opens: a wrong or ended one never connects.
    client = await within(connect({ port: n, runKey }));
    return client;
  } catch {
    client?.close();
    return null;
  }
}

const START_WAIT_TICKS = 300;

export async function startDaemon(dataDir: string): Promise<"started" | "already" | "failed"> {
  const up = await reach(dataDir);
  if (up) {
    up.client.close();
    return "already";
  }
  // Leave daemon.json alone: the new daemon replaces it once it holds the lock.
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const log = openSync(join(dataDir, "daemon.log"), "a");
  const child = spawn(process.execPath, [DAEMON], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  // Up to 30 s for its ready signal (a slow or loaded computer takes several seconds; 5 s gave up too early on
  // GitHub's macOS runners, 2026-11-28). A daemon that already exited won't answer: no point waiting.
  for (let i = 0; i < START_WAIT_TICKS && !exited; i++) {
    await sleep(100);
    const r = await reach(dataDir);
    if (r) {
      r.client.close();
      return "started";
    }
  }
  // It exited (another daemon may have won the lock): one last look before giving up.
  const last = exited ? await reach(dataDir) : null;
  last?.client.close();
  return last ? "started" : "failed";
}

/** Signals only a daemon that proved it is ion (see reach); anything else counts as not running. */
export async function stopDaemon(dataDir: string): Promise<"stopped" | "not-running"> {
  const up = await reach(dataDir);
  if (!up) {
    const info = readDaemonInfo(dataDir);
    if (info && !isAlive(info.pid)) rmSync(join(dataDir, "daemon.json"), { force: true });
    return "not-running";
  }
  const { pid } = up.info;
  up.client.close();
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 50 && isAlive(pid); i++) await sleep(100);
  // Still there: it and the agents it started (its process group: it was started detached, leading one).
  if (isAlive(pid)) killGroup(pid);
  rmSync(join(dataDir, "daemon.json"), { force: true });
  return "stopped";
}

const OPENERS: Partial<Record<NodeJS.Platform, string>> = { darwin: "open", win32: "explorer" };

/** Opens a folder in the system's file manager (Finder, Explorer, xdg-open); false when it can't be started. */
export function openFolder(path: string): boolean {
  const cmd = OPENERS[process.platform] ?? "xdg-open";
  try {
    const child = spawn(cmd, [path], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
