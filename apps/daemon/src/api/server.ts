import { chmodSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { runsView } from "../views/runs.js";
import { createAuth } from "./auth.js";
import type { Ctx } from "./commands.js";
import { Connection } from "./connection.js";
import { NeedsService } from "../needs/index.js";
import { RunManager } from "../runs/manager.js";
import { createGrants, createMcpHandler } from "../mcp/index.js";

export const VERSION = "0.0.0";
const MAX_MESSAGE_BYTES = 1024 * 1024;

export async function startServer(opts: {
  dataDir: string;
  configFile: string;
  port?: number;
}): Promise<{ port: number; token: string; close(): Promise<void> }> {
  mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
  chmodSync(opts.dataDir, 0o700); // mkdir's mode doesn't touch a folder that already exists
  const db = openDb(join(opts.dataDir, "ion.db"));
  const store = new EventStore(db, allViews);
  const needs = new NeedsService(store, db);
  const grants = createGrants();
  const ctx: Ctx = {
    store,
    db,
    needs,
    grants,
    runs: new RunManager(store, { configFile: opts.configFile, dataDir: opts.dataDir }, needs, db),
    configFile: opts.configFile,
    startedAt: Date.now(),
    version: VERSION,
  };
  ctx.runs.closeUnfinishedRuns(runsView.rows(db));
  const auth = createAuth();
  const http = httpServer(createMcpHandler({ store, db, grants: ctx.grants }));
  const wss = new WebSocketServer({
    server: http,
    maxPayload: MAX_MESSAGE_BYTES,
    // Refuse at the handshake, so unauthenticated peers never reach frame parsing.
    verifyClient: ({ req }: { req: IncomingMessage }) => auth.isAuthorized(req),
    handleProtocols: (protocols) => (protocols.has("ion") ? "ion" : false),
  });
  wss.on("error", () => {});
  http.on("error", () => {});
  await new Promise<void>((r) => http.listen(opts.port ?? 0, "127.0.0.1", r));
  wss.on("connection", (ws) => new Connection(ws, ctx));

  const addr = http.address();
  return {
    port: typeof addr === "object" && addr ? addr.port : 0,
    token: auth.token,
    close: async () => {
      await ctx.runs.shutdown();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
      db.close();
    },
  };
}

/** One port: the WebSocket API (upgrades), and ion's MCP server at /mcp for runs (with their own keys). */
function httpServer(mcp: ReturnType<typeof createMcpHandler>) {
  return createServer((req, res) => {
    if ((req.url ?? "/").split("?")[0] === "/mcp") void mcp(req, res).catch(() => res.destroy());
    else res.writeHead(404).end();
  });
}
