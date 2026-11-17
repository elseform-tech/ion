import { chmodSync, mkdirSync } from "node:fs";
import type { IncomingMessage } from "node:http";
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
  const ctx: Ctx = {
    store,
    db,
    needs: new NeedsService(store, db),
    runs: new RunManager(store, { configFile: opts.configFile }),
    configFile: opts.configFile,
    startedAt: Date.now(),
    version: VERSION,
  };
  ctx.runs.closeUnfinishedRuns(runsView.rows(db));
  const auth = createAuth();
  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port: opts.port ?? 0,
    maxPayload: MAX_MESSAGE_BYTES,
    // Refuse at the handshake, so unauthenticated peers never reach frame parsing.
    verifyClient: ({ req }: { req: IncomingMessage }) => auth.isAuthorized(req),
    handleProtocols: (protocols) => (protocols.has("ion") ? "ion" : false),
  });
  wss.on("error", () => {});
  await new Promise<void>((r) => wss.once("listening", r));
  wss.on("connection", (ws) => new Connection(ws, ctx));

  const addr = wss.address();
  return {
    port: typeof addr === "object" && addr ? addr.port : 0,
    token: auth.token,
    close: async () => {
      await ctx.runs.shutdown();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      db.close();
    },
  };
}
