import { dropInheritedMarkers } from "../env.js";
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
import { createGrants, createMcpHandler, type Grants, type RunScope } from "../mcp/index.js";
import { Ions } from "../ions/service.js";
import { IonTurns } from "../ions/turn.js";
import { IonQuestions } from "../ions/questions.js";
import { createSame } from "../ions/same.js";
import { diffOfChat, handlers, harnessInfos } from "./commands.js";
import { PromptQueue } from "../queue/index.js";
import { Routines } from "../scheduler/index.js";
import { Suggestions } from "../ions/suggestions.js";
import { chatsView } from "../views/chats.js";
import { addRoutineTo } from "./routines.js";

/** The scope of a run that ion asks you about. */
const runScopeOf = (r: AskingRun): RunScope => ({
  kind: "run",
  projectId: r.projectId,
  chatId: r.chatId,
  runId: r.runId,
});

export const VERSION = "0.0.0";
const MAX_MESSAGE_BYTES = 1024 * 1024;
/** What a stalled chat is sent when you resume it from ion chief's suggestion. */
const RESUME = "Pick up where you left off.";

export async function startServer(opts: {
  dataDir: string;
  configFile: string;
  port?: number;
}): Promise<{ port: number; token: string; close(): Promise<void> }> {
  dropInheritedMarkers(); // idempotent: embedders and tests start the server without main()
  let port = 0;
  const { ctx, turns } = openState(opts, () => `http://127.0.0.1:${port}`);
  const { db } = ctx;
  const auth = createAuth();
  const http = httpServer(ctx, turns);
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
  // Only now that ion listens (its tools have a port): the ions watch their threads end, and runs a crash left
  // unfinished end (their ions report them). Then what starts runs: routines on their schedule (one missed while
  // ion was stopped goes now), ion chief's suggestions (now, then hourly), and answers still waiting.
  ctx.ions.watch();
  ctx.runs.closeUnfinishedRuns(runsView.rows(db));
  const stopRoutines = ctx.routines.start();
  const stopSuggestions = ctx.suggestions.start();
  // Your answers still waiting go in first; then what you queued while ion was stopped, to each chat or ion that
  // isn't working.
  void ctx.decisions
    .resume()
    .catch(() => {})
    .then(() => ctx.queue.resume());
  return {
    port,
    token: auth.token,
    close: async () => {
      stopRoutines();
      stopSuggestions();
      // ion's turns stop first; nothing an ion says after is written.
      ctx.ions.stop();
      await turns.shutdown();
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
 * One port: the WebSocket API (upgrades), ion's MCP server at /mcp and the gate at /gate/<key>, both for runs and
 * ions' turns (with their own keys).
 */
function httpServer(ctx: Ctx, turns: IonTurns) {
  const { store, db, grants, decisions, configFile } = ctx;
  // An ion's turn starts threads with its start_thread tool.
  const mcp = createMcpHandler({ store, db, grants, decisions, configFile, startThread: turns.startThread });
  const gate = createGateHandler({
    grants,
    decide: (scope, payload) => ctx.runs.gate(scope.runId, payload),
    // An ion's turn reports its tool calls here too: it may only read.
    ion: (scope, payload) => turns.gate(scope, payload),
  });
  return createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    if (path === "/mcp") void mcp(req, res).catch(() => res.destroy());
    else if (path.startsWith("/gate/")) void gate(req, res).catch(() => res.destroy());
    else res.writeHead(404).end();
  });
}

/**
 * Auto: rules, then a judge on its own model ([access] judge). Your secrets and ion's own files (and a custom Grok folder,
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

/**
 * ion chief's suggestions: a routine is added the way you'd add it; a stalled chat gets its follow-up through the
 * normal ask, on the chat's own agent.
 */
function chiefSuggestions(c: Pick<Ctx, "store" | "db" | "configFile" | "runs" | "routines">): Suggestions {
  return new Suggestions({
    ...{ store: c.store, db: c.db, configFile: c.configFile },
    changes: async (chatId) => (await diffOfChat(c, chatId)).files.length,
    addRoutine: (projectId, r) => void addRoutineTo(c, projectId, r),
    resume: async (chatId) => {
      const harness = chatsView.session(c.db, chatId)?.harness ?? null;
      await c.runs.ask(followAsk(chatId, { harness, text: RESUME }));
    },
  });
}

/**
 * ion chief and the project ions: each message a turn of the ion's own agent session (IonTurns) with ion's tools
 * (MCP) and a gate that only lets it read. They watch their threads end once ion listens (startServer).
 */
function startIons(
  d: Omit<ConstructorParameters<typeof Ions>[0], "agents" | "turns"> & {
    dataDir: string;
    grants: Grants;
    base: () => string;
  },
): { ions: Ions; turns: IonTurns } {
  const { dataDir, grants, base, ...deps } = d;
  const agents = () => harnessInfos.list();
  // Turns start threads through the ions, and the ions think through turns: the ions are made just below.
  const late: { ions?: Ions } = {};
  const turns = new IonTurns({
    ...{ store: d.store, db: d.db, configFile: d.configFile, dataDir, grants, agents },
    mcpUrl: () => `${base()}/mcp`,
    gateUrl: () => `${base()}/gate`,
    startThread: (projectId, brief, turn) =>
      late.ions?.startThread(projectId, brief, turn) ?? Promise.resolve({ why: "ion is starting" }),
  });
  const ions = new Ions({ ...deps, turns, agents });
  late.ions = ions;
  // A message ion stopped before answering is answered now, so no ion chat shows "Thinking" forever.
  ions.answerUnanswered();
  return { ions, turns };
}

/**
 * Your queued messages: a chat's goes out as ask does (the chat's own agent when none was picked), an ion's as your
 * message to it; each when the chat's run or the ion's turn ends.
 */
function promptQueue(c: Omit<Ctx, "queue">): PromptQueue {
  const { runs, ions } = c;
  const late: { ctx?: Ctx } = {};
  const queue = new PromptQueue({
    ...{ store: c.store, db: c.db, ions },
    chats: {
      ask: (a) => handlers.ask(a, late.ctx!),
      busy: (chatId) => runs.busy(chatId),
      stop: (chatId) => runs.stopChat(chatId),
      onEnded: (fn) => runs.onEnded(fn),
      answersWaiting: (chatId) => c.decisions.hasWaiting(chatId),
      dropQuestions: (chatId) => c.needs.supersedeChat(chatId),
    },
  });
  late.ctx = { ...c, queue };
  return queue;
}

/**
 * At the start: questions about calls stopped before (none still waits) close, and questions held behind one that
 * closed while ion was stopped come to you now.
 */
function sweepNeeds(needs: NeedsService, ionQuestions: IonQuestions): void {
  needs.supersedeStoppedCalls();
  ionQuestions.sweep();
}

/** The data folder, the event store and the services every connection shares. */
function openState(
  opts: { dataDir: string; configFile: string },
  base: () => string,
): { ctx: Ctx; turns: IonTurns } {
  mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
  chmodSync(opts.dataDir, 0o700); // mkdir's mode doesn't touch a folder that already exists
  const db = openDb(join(opts.dataDir, "ion.db"));
  const store = new EventStore(db, allViews);
  const needs = new NeedsService(store, db);
  const grants = createGrants();
  const quick = harnessRunner(opts.configFile);
  // How ion itself thinks (ion chief, the project ions, answering from your decisions): [ion] quick in Settings.
  const ionQuick = harnessRunner(opts.configFile, "quick");
  const ionQuestions = new IonQuestions({ store, db, needs, same: createSame(ionQuick) });
  sweepNeeds(needs, ionQuestions);
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
        late.decisions?.askBlocked(runScopeOf(r), b) ?? Promise.resolve("timeout" as const),
      allowed: (r: AskingRun, key: string) =>
        late.decisions?.alwaysAllowed(r.projectId, r.chatId, key) ?? false,
    },
  };
  const runs = new RunManager(store, runCtx, needs, db);
  // Your answer to an agent's question goes back into its chat as the next message, on the chat's harness.
  const decisions = new Decisions({
    ...{ store, db, needs },
    match: createMatcher(ionQuick),
    ion: ionQuestions,
    followUp: async (chatId, m) =>
      (await runs.ask(followAsk(chatId, m), { request: m.request, shown: m.shown })).runId,
    requestOf: (runId) => runs.requestOf(runId),
  });
  late.decisions = decisions;
  const { ions, turns } = startIons({ store, db, ...opts, runs, grants, base });
  // A routine's time came (or you ran it now): its ion starts its thread.
  const routines = new Routines({
    ...{ store, db, configFile: opts.configFile },
    start: (projectId, r, by) => ions.routine(projectId, r, by),
  });
  const suggestions = chiefSuggestions({ store, db, configFile: opts.configFile, runs, routines });
  const base0 = { configFile: opts.configFile, startedAt: Date.now(), version: VERSION };
  const shared = { store, db, needs, decisions, grants, runs, ions, routines, suggestions, ...base0 };
  const ctx = { ...shared, queue: promptQueue(shared) };
  return { ctx, turns };
}
