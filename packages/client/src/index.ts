import { readFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { createClient, type IonClient, protocols, runProtocols } from "./core.js";

export { ApiCallError, type IonClient } from "./core.js";

export type DaemonInfo = { pid: number; port: number; token: string };

/** Reads `daemon.json` from the data dir, or null when it's missing or unreadable. */
export function readDaemonInfo(dataDir: string): DaemonInfo | null {
  try {
    const x = JSON.parse(readFileSync(join(dataDir, "daemon.json"), "utf8")) as DaemonInfo;
    const ok =
      Number.isInteger(x.pid) &&
      x.pid > 0 &&
      Number.isInteger(x.port) &&
      x.port >= 1 &&
      x.port <= 65535 &&
      typeof x.token === "string" &&
      x.token.length > 0;
    return ok ? x : null;
  } catch {
    return null;
  }
}

/**
 * The daemon's address on this computer, only: ion's token never leaves it (CodeQL on main, 2026-11-22,
 * js/file-access-to-http: the token read from ion's file went to whatever host was asked). Another host throws.
 * "localhost" goes to 127.0.0.1 (review, 2026-11-22: a hosts-file entry can send that name elsewhere): only the numeric
 * loopback addresses are ever connected to.
 */
const LOOPBACK: Record<string, string> = { "127.0.0.1": "127.0.0.1", "::1": "[::1]", localhost: "127.0.0.1" };

export function daemonUrl(port: number, host = "127.0.0.1"): string {
  const h = Object.hasOwn(LOOPBACK, host) ? LOOPBACK[host] : undefined;
  if (!h) throw new Error(`ion connects only to this computer, not ${host}`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`not a port: ${port}`);
  return `ws://${h}:${port}/`;
}

/**
 * Opens an authenticated connection to the daemon (Node: the CLI and tests): with ion's token, or with a chat's run
 * key (inside a chat: only ion's commands for tools). Only on this computer.
 */
export async function connect(
  opts: { port: number; host?: string } & ({ token: string } | { runKey: string }),
): Promise<IonClient> {
  const url = daemonUrl(opts.port, opts.host);
  const auth = "runKey" in opts ? runProtocols(opts.runKey) : protocols(opts.token);
  const ws = new WebSocket(url, auth);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return createClient({
    send: (t) => ws.send(t),
    close: () => ws.close(),
    onMessage: (fn) => void ws.on("message", (raw) => fn(String(raw))),
    onClose: (fn) => void ws.on("close", fn),
  });
}
