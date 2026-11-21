import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import type { Command } from "@ion/schema";
import type { Grants, RunScope } from "../mcp/index.js";
import { type Net, systemNet } from "../secrets/oauth-net.js";
import { type Added, createAdded, createSeen, type Seen } from "../tools/added.js";

const RUN_PREFIX = "ion.run.";

/**
 * What a chat's agent may ask with its run's key (`ION_RUN_KEY`, the `ion` CLI inside a chat): ion's commands for
 * tools, where adding changes nothing until you turn it on. Never turning anything on, keys, sign-in or your settings.
 */
const RUN_MAY = new Set<string>([
  "status",
  "tools.search",
  "tools.add",
  "tools.verify",
  "tools.doctor",
  "tools.remove",
  "tools.items",
]);

/** Why a chat's agent can't make this call, or null when it can. */
export function runRefusal(cmd: Command | string): string | null {
  if (RUN_MAY.has(cmd)) return null;
  if (cmd === "tools.setOn") return "Only you can turn it on, in Settings → Tools";
  // Import reads your other agents' own configs, which a chat shouldn't see (Task 9, 2026-11-21).
  if (cmd === "tools.importable" || cmd === "tools.import" || cmd === "tools.dismissImport")
    return "Only you can import";
  return "A chat's agent can't do that";
}

/**
 * Who may open a WebSocket: you (ion's token) or a running chat's agent (its run's key), and which run that is (none:
 * you).
 */
export const wsAccess = (auth: { isAuthorized(req: IncomingMessage): boolean }, grants: Grants) => ({
  verify: (req: IncomingMessage) => auth.isAuthorized(req) || runCallerOf(req, grants) !== null,
  callerOf: (req: IncomingMessage): RunCaller | undefined =>
    auth.isAuthorized(req) ? undefined : (runCallerOf(req, grants) ?? undefined),
});

/**
 * A chat's agent on a socket: its run, and whether its key still works (Task review, 2026-11-21: checked on every
 * request, so a socket outlives its run's access by nothing).
 */
export type RunCaller = { scope: RunScope; live: () => boolean };

/** What a run-key socket is told once its run has ended. */
export const RUN_ENDED = "This chat's run has ended";

/** The run whose key a WebSocket handshake offers (as a subprotocol, like ion's token), while that run goes. */
function runCallerOf(req: IncomingMessage, grants: Grants): RunCaller | null {
  const offered = String(req.headers["sec-websocket-protocol"] ?? "").split(",");
  for (const raw of offered) {
    const p = raw.trim();
    if (!p.startsWith(RUN_PREFIX)) continue;
    const key = p.slice(RUN_PREFIX.length);
    const scope = grants.check(key, "cli");
    if (scope?.kind === "run") return { scope, live: () => grants.check(key, "cli") !== null };
  }
  return null;
}

/** What ion's commands for tools need: the network (the MCP Registry, a package's registry) and who added what. */
export const cliOf = (o: { dataDir: string; net?: Net }): { net: Net; added: Added; seen: Seen } => ({
  net: o.net ?? systemNet,
  added: createAdded(join(o.dataDir, "added.json")),
  seen: createSeen(join(o.dataDir, "seen.json")),
});
