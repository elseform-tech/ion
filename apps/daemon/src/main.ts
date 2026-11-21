import { closeSync, mkdirSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setStandingDrop } from "@ion/adapter-kit";
import { ionPaths } from "@ion/config";
import { harnessInfos } from "./api/commands.js";
import { dropInheritedMarkers } from "./env.js";
import { startServer } from "./api/server.js";
import { acquireDaemonLock } from "./store/index.js";
import { standingDropOf } from "./tools/env-drop.js";
import { MCP_GROUPS, sweepGroups } from "./workspace/server-groups.js";

export { startServer, VERSION } from "./api/server.js";

async function main() {
  dropInheritedMarkers();
  const { dataDir, configFile } = ionPaths();
  // Before anything starts an agent: what none of them may inherit (your keys, from mcp.json).
  setStandingDrop(standingDropOf(configFile));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // One daemon per data folder; the OS releases this lock if the process dies.
  const lock = acquireDaemonLock(dataDir);
  if (!lock) {
    console.log("Already running");
    process.exit(0);
  }
  // Your local servers an earlier ion left running (it died without stopping them): stopped before any run starts.
  await sweepGroups(join(dataDir, MCP_GROUPS));
  const infoFile = join(dataDir, "daemon.json");
  const srv = await startServer({ dataDir, configFile });
  // Ask each agent what it is now, so the app's first list of agents and models doesn't wait.
  harnessInfos.warm();
  // Never follow a planted file or symlink: remove it, then create exclusively with 0600.
  rmSync(infoFile, { force: true });
  const fd = openSync(infoFile, "wx", 0o600);
  writeFileSync(fd, JSON.stringify({ pid: process.pid, port: srv.port, token: srv.token }));
  closeSync(fd);
  const stop = async () => {
    rmSync(infoFile, { force: true });
    await srv.close();
    lock.release();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

const entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (import.meta.url === entry) void main();
