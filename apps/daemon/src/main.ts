import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ionPaths } from "@ion/config";
import { startServer } from "./api/server.js";

export { startServer, VERSION } from "./api/server.js";

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function main() {
  const { dataDir, configFile } = ionPaths();
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const infoFile = join(dataDir, "daemon.json");
  const lock = join(dataDir, "daemon.lock");
  // One daemon per data dir: the lock file holds the owner's pid; a dead owner's lock is taken over.
  try {
    writeFileSync(lock, String(process.pid), { flag: "wx" });
  } catch {
    const { readFileSync } = await import("node:fs");
    const owner = Number(readFileSync(lock, "utf8"));
    if (owner && owner !== process.pid && isAlive(owner)) {
      console.log("Already running");
      process.exit(0);
    }
    writeFileSync(lock, String(process.pid));
  }
  const srv = await startServer({ dataDir, configFile });
  writeFileSync(infoFile, JSON.stringify({ pid: process.pid, port: srv.port, token: srv.token }), {
    mode: 0o600,
  });
  const stop = async () => {
    rmSync(infoFile, { force: true });
    rmSync(lock, { force: true });
    await srv.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
