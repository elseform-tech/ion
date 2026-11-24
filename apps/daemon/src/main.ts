import { closeSync, mkdirSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setStandingDrop } from "@ion/adapter-kit";
import { ionPaths } from "@ion/config";
import { harnessInfos } from "./api/commands.js";
import { agentsHome, dropInheritedMarkers } from "./env.js";
import { startServer } from "./api/server.js";
import { watchLease } from "./lease.js";
import { acquireDaemonLock } from "./store/index.js";
import { standingDropOf } from "./tools/env-drop.js";
import { MCP_GROUPS, sweepGroups } from "./workspace/server-groups.js";

export { startServer, VERSION } from "./api/server.js";

async function main() {
  const home = agentsHome(); // before ION_AGENTS_HOME is dropped
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
  const srv = await startServer({ dataDir, configFile, home });
  // Ask each agent what it is now, so the app's first list of agents and models doesn't wait.
  harnessInfos.warm();
  // Never follow a planted file or symlink: remove it, then create exclusively with 0600.
  rmSync(infoFile, { force: true });
  const fd = openSync(infoFile, "wx", 0o600);
  writeFileSync(fd, JSON.stringify({ pid: process.pid, port: srv.port, token: srv.token }));
  closeSync(fd);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    rmSync(infoFile, { force: true });
    await srv.close();
    lock.release();
    await stopAgents();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // A daemon a test started stops once its test run is gone (never yours: it has no lease).
  watchLease(process.env, () => void stop());
}

/**
 * The agents ion started (opencode, grok, claude, their probes) and what they started end with it: `ion daemon start`
 * makes ion lead its own process group, and its agents share it (2026-11-23: `opencode acp`, grok and claude's hook
 * helpers outlived their daemons). Asked to end first, then ended; that ends ion too, its own work already done.
 * Started some other way, ion leads no group and this does nothing.
 */
async function stopAgents(): Promise<void> {
  const group = (signal: NodeJS.Signals) => {
    try {
      process.kill(-process.pid, signal);
      return true;
    } catch {
      return false; // no group of its own
    }
  };
  if (!group("SIGTERM")) return;
  await new Promise((r) => setTimeout(r, 300));
  group("SIGKILL");
}

const entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (import.meta.url === entry) void main();
