import { chmodSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { WebSocketServer } from "ws";
import { EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { runsView } from "../views/runs.js";
import { createAuth } from "./auth.js";
import type { Ctx } from "./commands.js";
import { Connection } from "./connection.js";
import { NeedsService } from "../needs/index.js";
import { RunManager } from "../runs/manager.js";
import { createAccess, createJudge, harnessRunner } from "../access/index.js";
import { createMatcher, Decisions } from "../decisions/index.js";
import type { Blocked } from "../decisions/blocked.js";
import type { AskingRun } from "../runs/approvals.js";
import { createGateHandler } from "../gate/index.js";
import { createGrants, createMcpHandler } from "../mcp/index.js";
import { Ions } from "../ions/service.js";
import { IonQuestions } from "../ions/questions.js";
import { createSame } from "../ions/same.js";

export const VERSION = "0.0.0";
const MAX_MESSAGE_BYTES = 1024 * 1024;

export async function startServer(opts: {
  dataDir: string;
  configFile: string;
  port?: number;
}): Promise<{ port: number; token: string; close(): Promise<void> }> {
  let port = 0;
  const ctx = openState(opts, () => `http://127.0.0.1:${port}`);
  const { store, db } = ctx;
  ctx.runs.closeUnfinishedRuns(runsView.rows(db));
  // Answers still waiting when ion stopped go into their chats now.
  void ctx.decisions.resume().catch(() => {});
  const auth = createAuth();
  const http = httpServer(
    createMcpHandler({ store, db, grants: ctx.grants, decisions: ctx.decisions }),
    createGateHandler({
      grants: ctx.grants,
      decide: (scope, payload) => ctx.runs.gate(scope.runId, payload),
    }),
  );
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
  port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
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

/**
 * One port: the WebSocket API (upgrades), ion's MCP server at /mcp and the gate at /gate/<key>, both for runs
 * (with their own keys).
 */
function httpServer(mcp: ReturnType<typeof createMcpHandler>, gate: ReturnType<typeof createGateHandler>) {
  return createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    if (path === "/mcp") void mcp(req, res).catch(() => res.destroy());
    else if (path.startsWith("/gate/")) void gate(req, res).catch(() => res.destroy());
    else res.writeHead(404).end();
  });
}

/**
 * Auto: rules, then a judge on ion's quick harness. Your secrets and ion's own files (and a custom Grok folder,
 * where ion's gate hook lives; ~/.grok is covered by name) are always denied; the judge weighs your decisions.
 */
function autoAccess(
  opts: { dataDir: string; configFile: string },
  quick: ReturnType<typeof harnessRunner>,
  late: { decisions?: Decisions },
) {
  return createAccess({
    judge: createJudge(quick),
    home: homedir(),
    ionDirs: [
      opts.dataDir,
      dirname(opts.configFile),
      ...(process.env.GROK_HOME ? [process.env.GROK_HOME] : []),
    ],
    decisionsFor: (projectId, chatId) => late.decisions?.forJudge(projectId, chatId) ?? [],
  });
}

/** An answer's message as ask arguments: its chat, its text, and the chat's agent. */
const followAsk = (chatId: string, m: { harness: string | null; text: string }) => ({
  chatId,
  text: m.text,
  ...(m.harness ? { harness: m.harness } : {}),
});

/** The data folder, the event store and the services every connection shares. */
function openState(opts: { dataDir: string; configFile: string }, base: () => string): Ctx {
  mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
  chmodSync(opts.dataDir, 0o700); // mkdir's mode doesn't touch a folder that already exists
  const db = openDb(join(opts.dataDir, "ion.db"));
  const store = new EventStore(db, allViews);
  const needs = new NeedsService(store, db);
  const grants = createGrants();
  const quick = harnessRunner(opts.configFile);
  // Made after the run manager it needs; the judge and the gate reach it through this holder.
  const late: { decisions?: Decisions } = {};
  const access = autoAccess(opts, quick, late);
  const runCtx = {
    configFile: opts.configFile,
    dataDir: opts.dataDir,
    access,
    mcp: { grants, url: () => `${base()}/mcp` },
    gate: { url: () => `${base()}/gate` },
    // When ion stops a tool call it asks you; made here, answered through the decisions made below.
    askBlocked: {
      ask: (r: AskingRun, b: Blocked) =>
        late.decisions?.askBlocked({ projectId: r.projectId, chatId: r.chatId, runId: r.runId }, b) ??
        Promise.resolve("timeout" as const),
      allowed: (r: AskingRun, key: string) =>
        late.decisions?.alwaysAllowed(r.projectId, r.chatId, key) ?? false,
    },
  };
  const runs = new RunManager(store, runCtx, needs, db);
  // Your answer to an agent's question goes back into its chat as the next message, on the chat's harness.
  const decisions = new Decisions({
    store,
    db,
    needs,
    match: createMatcher(quick),
    ion: new IonQuestions({ store, db, needs, same: createSame(quick) }),
    followUp: async (chatId, m) =>
      (await runs.ask(followAsk(chatId, m), { request: m.request, shown: m.shown })).runId,
    requestOf: (runId) => runs.requestOf(runId),
  });
  late.decisions = decisions;
  const ions = new Ions({ store, db, configFile: opts.configFile, runs, quick });
  ions.watch();
  const base0 = { configFile: opts.configFile, startedAt: Date.now(), version: VERSION };
  return { store, db, needs, decisions, grants, runs, ions, ...base0 };
}
