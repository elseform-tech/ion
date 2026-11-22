import type { GateCall } from "@ion/adapter-kit";
import { randomUUID } from "node:crypto";
import { loadUserConfig } from "@ion/config";
import { agentsHome, dropInheritedMarkers } from "../env.js";
import { createServer, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import type { EventStore } from "../store/index.js";
import { runsView } from "../views/runs.js";
import { createAuth } from "./auth.js";
import { cliOf, wsAccess } from "./run-calls.js";
import { Connection } from "./connection.js";
import { yourToolsOf } from "./tools.js";
import { NeedsService } from "../needs/index.js";
import { RunManager } from "../runs/manager.js";
import { startSandbox } from "../runs/sandbox.js";
import { startHooks } from "../hooks/start.js";
import { ionLauncher } from "../runs/ion-bin.js";
import { createAccess, createJudge, harnessRunner, ionDirsOf } from "../access/index.js";
import { judgeOthers, startOwnAgents } from "../access/runner.js";
import { theirRulesOf } from "../access/agent-rules.js";
import { UnsureLog } from "../access/unsure.js";
import { createMatcher, Decisions } from "../decisions/index.js";
import type { Blocked } from "../decisions/blocked.js";
import type { AskingRun } from "../runs/approvals.js";
import { createGateHandler } from "../gate/index.js";
import { createGrants, createMcpHandler, type Grants, type RunScope } from "../mcp/index.js";
import { createGateway } from "../gateway/index.js";
import { Ions } from "../ions/service.js";
import { IonTurns } from "../ions/turn.js";
import { IonServers } from "../ions/servers.js";
import { ownServerNames, pickSource } from "./tools-picks.js";
import { IonQuestions } from "../ions/questions.js";
import { createSame } from "../ions/same.js";
import { type Ctx, diffOfChat, handlers, harnessInfos, useAgentsHome } from "./commands.js";
import { PromptQueue } from "../queue/index.js";
import { Dreams, dreamThink, Routines } from "../scheduler/index.js";
import { Suggestions } from "../ions/suggestions.js";
import { TodoOffers } from "../ions/todo-offers.js";
import { chatsView } from "../views/chats.js";
import { addRoutineTo } from "./routines.js";
import { Notifier } from "../notify/index.js";
import { type Secrets, systemSecrets } from "../secrets/index.js";
import { createTools, type Tools } from "../tools/index.js";
import { createOAuth, type OAuth } from "../secrets/oauth.js";
import { serversFor } from "../tools/run-servers.js";
import { setDropLookup } from "../tools/env-drop.js";
import type { Net } from "../secrets/oauth-net.js";
import { createVault } from "../secrets/vault.js";
import { Hooks } from "../hooks/index.js";
import { createSkills, ionSkillsDir, type Skills } from "../skills/index.js";
import { runSkillsOf } from "../skills/run.js";
import { type AskInChat, runOwnOf } from "../tools/own-run.js";
import { skillReaders } from "../adapters/registry.js";
import { openStore } from "./open-store.js";
import type { MemoryFiles } from "../memory/index.js";

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

type ServerOpts = {
  dataDir: string;
  configFile: string;
  port?: number;
  /** Where keys and tokens are kept: the OS keychain unless given (tests keep them in memory). */
  secrets?: Secrets;
  /** How ion reaches remote servers to sign in (tests: nothing leaves the computer). */
  net?: Net;
  /** Where your agents' skills are looked for: your home folder unless given (tests). */
  home?: string;
};

/** Your connections (mcp.json beside the config file) and the keychain. */
const toolsOf = (o: Pick<ServerOpts, "configFile" | "secrets" | "dataDir">) => {
  const secrets = o.secrets ?? systemSecrets();
  // Tokens are too big for the keychain: they're in the vault, whose key is in the keychain.
  return createTools({
    configFile: o.configFile,
    secrets,
    tokens: createVault({ dir: join(o.dataDir, "vault"), keychain: secrets }),
  });
};

/**
 * Where your agents' configs are, read once before ION_AGENTS_HOME is dropped (security review, 2026-11-22); then the
 * per-run variables go (idempotent: embedders and tests start the server without main()).
 */
function withAgentsHome<T extends ServerOpts>(given: T): T & { home: string } {
  const opts = { ...given, home: given.home ?? agentsHome() };
  useAgentsHome(opts.home);
  dropInheritedMarkers();
  return opts;
}

export async function startServer(
  given: ServerOpts,
): Promise<{ port: number; token: string; oauth: OAuth; grants: Grants; close(): Promise<void> }> {
  const opts = withAgentsHome(given);
  let port = 0;
  const { ctx, turns } = openState(opts, () => `http://127.0.0.1:${port}`);
  const { db } = ctx;
  const auth = createAuth();
  const who = wsAccess(auth, ctx.grants);
  const http = httpServer(ctx, turns);
  const wss = new WebSocketServer({
    server: http,
    maxPayload: MAX_MESSAGE_BYTES,
    // Refuse at the handshake, so unauthenticated peers never reach frame parsing. A run's key: ion's tool commands.
    verifyClient: ({ req }: { req: IncomingMessage }) => who.verify(req),
    handleProtocols: (protocols) => (protocols.has("ion") ? "ion" : false),
  });
  wss.on("error", () => {});
  http.on("error", () => {});
  await new Promise<void>((r) => http.listen(opts.port ?? 0, "127.0.0.1", r));
  wss.on("connection", (ws, req) => new Connection(ws, ctx, who.callerOf(req)));
  // A hand-edited setting that fell back to its default: say so once, in the daemon's log.
  const { warning } = loadUserConfig(opts.configFile);
  if (warning) console.warn(warning);

  const addr = http.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
  // Only now that ion listens (its tools have a port): the ions watch their threads end, notifications and ion
  // chief's daily briefing start (a run ion's own restart ends isn't told as a failure), and runs a crash left
  // unfinished end (their ions report them). Then what starts runs: routines on their schedule (one missed while
  // ion was stopped goes now), ion chief's suggestions (now, then hourly), and answers still waiting.
  ctx.ions.watch();
  const unwatch = ctx.memory.watch(); // first: the briefing and reminders read memory as it is now
  const notifier = new Notifier({ store: ctx.store, db, configFile: opts.configFile, memory: ctx.memory });
  const stopNotifier = notifier.start();
  ctx.runs.closeUnfinishedRuns(runsView.rows(db));
  const stops = [ctx.routines.start(), ctx.suggestions.start(), ctx.dreams!.start(), stopNotifier, unwatch];
  // Your answers still waiting go in first; then what you queued while ion was stopped, to each chat or ion that
  // isn't working.
  void ctx.decisions
    .resume()
    .catch(() => {})
    .then(() => ctx.queue.resume());
  return {
    port,
    token: auth.token,
    oauth: ctx.oauth,
    grants: ctx.grants,
    close: async () => {
      for (const stop of stops) stop();
      await stopWork(ctx, turns);
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
 * ions' turns (with their own keys), and ion's gateway to your remote MCP servers at /mcp/s/<name> (runs only).
 */
function httpServer(ctx: Ctx, turns: IonTurns) {
  const { store, db, grants, decisions, configFile, memory } = ctx;
  // An ion's turn starts threads with its start_thread tool.
  const mcp = createMcpHandler({
    ...{ store, db, grants, decisions, configFile, memory },
    startThread: turns.startThread,
    // ion's own tools tell an ion your connections and skills by name; it never gets them itself.
    yourTools: yourToolsOf(ctx),
  });
  const gate = createGateHandler({
    grants,
    decide: (scope, payload) => ctx.runs.gate(scope.runId, payload),
    // An ion's turn reports its tool calls here too: it may only read.
    ion: (scope, payload) => turns.gate(scope, payload),
  });
  // Your remote MCP servers, through ion: each run's agent reaches only the ones given to it, with its own key.
  const gateway = createGateway({
    grants,
    upstream: (runId, name) => ctx.runs.upstream(runId, name),
    gate: (runId, call) => ctx.runs.gateMcp(runId, call),
    // An ion's turn reaches your servers too, with its turn's key: only what reads (ion's gate for ions).
    ...(ctx.ionServers
      ? {
          ion: {
            upstream: (turnId: string, name: string) => ctx.ionServers!.upstream(turnId, name),
            gate: (turnId: string, call: GateCall) => turns.gateMcp(turnId, call),
          },
        }
      : {}),
  });
  ctx.runs.onEnded(() => gateway.closeEnded());
  return createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    if (path.startsWith("/mcp/s/")) void gateway.handle(req, res).catch(() => res.destroy());
    else if (path === "/mcp") void mcp(req, res).catch(() => res.destroy());
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
  unsure: UnsureLog,
) {
  return createAccess({
    judge: judgeOn(opts, quick),
    // Unsure often on one kind of action: said once in the log (and `ion status`), so a rule can be added.
    onUnsure: (req) => {
      const note = unsure.add(req);
      if (note) console.warn(note);
    },
    home: homedir(),
    ionDirs: ionDirsOf(opts),
    decisionsFor: (projectId, chatId) => late.decisions?.forJudge(projectId, chatId) ?? [],
  });
}

/** Auto's judge: its second try on another agent signed in now. */
const judgeOn = (opts: { dataDir: string; configFile: string }, quick: ReturnType<typeof harnessRunner>) =>
  createJudge(quick, undefined, judgeOthers(opts, readyAgents));

/** The agents signed in now (the judge's second try picks one). */
const readyAgents = async () =>
  (await harnessInfos.list()).filter((h) => h.installed && h.signedIn).map((h) => h.id);

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
function chiefSuggestions(c: Pick<Ctx, "store" | "db" | "configFile" | "runs" | "routines" | "memory">) {
  const base = { store: c.store, db: c.db, configFile: c.configFile };
  const changed = async (chatId: string) => (await diffOfChat(c, chatId)).files.map((f) => f.path);
  return new Suggestions({
    ...base,
    // "Mark done?" when a chat's finished work matches an open to-do.
    todos: new TodoOffers({ ...base, memory: c.memory, changed }),
    changes: async (chatId) => (await changed(chatId)).length,
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
    ionServers: IonServers;
    memory: MemoryFiles;
  },
): { ions: Ions; turns: IonTurns; dreams: Dreams } {
  const { dataDir, grants, base, ionServers, memory, ...deps } = d;
  const agents = () => harnessInfos.list();
  const agent = (id: string) => harnessInfos.one(id);
  // Turns start threads through the ions, and the ions think through turns: the ions are made just below.
  const late: { ions?: Ions } = {};
  const turns = new IonTurns({
    ...{ store: d.store, db: d.db, configFile: d.configFile, dataDir, grants, agents, agent, memory },
    mcpUrl: () => `${base()}/mcp`,
    gateUrl: () => `${base()}/gate`,
    servers: ionServers,
    startThread: (projectId, brief, turn, picks) =>
      late.ions
        ? late.ions.startThread(projectId, brief, turn, picks)
        : Promise.resolve({ why: "ion is starting" }),
  });
  const ions = new Ions({ ...deps, turns, agents, agent });
  late.ions = ions;
  // A message ion stopped before answering is answered now, so no ion chat shows "Thinking" forever.
  ions.answerUnanswered();
  // ion's dream: it tidies memory overnight, as one of ion's turns (Settings → Memory).
  const dreams = new Dreams({ ...d, memory, think: dreamThink(turns) });
  return { ions, turns, dreams };
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

/** Signing in to your remote servers: your browser comes back to ion's callback port, tokens go to the vault. */
const oauthOf = (tools: Tools, store: EventStore, net?: Net): OAuth =>
  createOAuth({
    ...{ secrets: tools.tokens, store, resolve: (id: string) => tools.remote(id) },
    ...(net ? { net } : {}),
  });

/** Your connections (mcp.json, keys) and signing in to them. */
function connectionsOf(
  opts: { configFile: string; dataDir: string; secrets?: Secrets; net?: Net; home?: string },
  store: EventStore,
  late: { decisions?: Decisions },
) {
  const tools = toolsOf(opts);
  // Your keys, as filling reads them (keychain, then ion's environment), for what no agent may inherit.
  setDropLookup(tools.lookup);
  const skills = skillsOf(opts, tools);
  // What a chat's run gets besides your servers: your skills, and its agent's own tools.
  const forRuns = {
    skills: runSkillsOf(skills, opts.configFile),
    own: runOwnOf({
      home: skills.home,
      dataDir: opts.dataDir,
      configFile: opts.configFile,
      sign: tools.sign,
      ask: repoAsker(late),
    }),
  };
  const ionBin = ionLauncher(opts.dataDir);
  return { tools, oauth: oauthOf(tools, store, opts.net), skills, forRuns, cli: cliOf(opts), ionBin };
}

/**
 * ion's turns stop first (nothing an ion says after is written), then runs; your hooks stop only once no run is left
 * to ask them (each running one with all it started).
 */
async function stopWork(ctx: Ctx, turns: IonTurns): Promise<void> {
  ctx.ions.stop();
  await ctx.oauth.close();
  await turns.shutdown();
  await ctx.runs.shutdown();
  ctx.hooks.stop();
}

/** Your agents' skills; plugins left by runs ion didn't see end are removed first. */
function skillsOf(opts: { dataDir: string; configFile: string; home?: string }, tools: Tools): Skills {
  const skills = createSkills({
    ...{ home: opts.home ?? agentsHome(), dataDir: opts.dataDir, ionDir: ionSkillsDir(opts.configFile) },
    ...{ sign: tools.sign, readers: skillReaders() },
  });
  try {
    skills.sweep();
  } catch {
    // A folder ion can't remove now is made afresh per run anyway.
  }
  return skills;
}

/** Your answer to a repo server's question: yes, no, or none in time (not kept: ion asks again). */
const HELD_ANSWER = { allow: true, deny: false, timeout: null } as const;

/**
 * Asks in a run's chat about a repo's server that runs the repo's own code (ruling, 2026-11-21): "Allow for this chat"
 * lets it start in that chat; no answer in 4 minutes is a no.
 */
const repoAsker =
  (late: { decisions?: Decisions }): AskInChat =>
  async (r, text, command) => {
    const b: Blocked = {
      requestId: `repo-${randomUUID()}`,
      summary: text,
      reason: command,
      key: `repo ${text}`,
      repo: true,
    };
    const h = await late.decisions?.askBlocked({ kind: "run", ...r }, b);
    return HELD_ANSWER[h ?? "timeout"];
  };

/** What a run needs besides its access and servers: picks, hooks, ion's server and gate, and asking you. */
function runCtxOf(o: {
  opts: { dataDir: string; configFile: string; home?: string };
  base: () => string;
  late: { decisions?: Decisions };
  grants: Grants;
  hooks: Hooks;
  picks: { tools: Tools; skills: Skills; ionServers: IonServers };
  memory: MemoryFiles;
}) {
  const { opts, base, late } = o;
  return {
    ...{ configFile: opts.configFile, dataDir: opts.dataDir },
    // A message's "/" and "@" picks, as its agent takes them.
    picks: (agent: string, projectId: string) => {
      const dir = loadUserConfig(opts.configFile).config.projects.find((p) => p.id === projectId)?.path;
      return pickSource({ ...o.picks, configFile: opts.configFile }, agent, dir ? [dir] : []);
    },
    beforeTool: (r: AskingRun, c: Parameters<Hooks["beforeTool"]>[1]) => o.hooks.beforeTool(r, c),
    theirs: theirRulesOf(opts.configFile, opts.home ?? agentsHome()),
    mcp: { grants: o.grants, url: () => `${base()}/mcp`, memory: o.memory },
    gate: { url: () => `${base()}/gate` },
    // `ion` inside a run reaches ion by this port and its run key (daemon.json is out of the run's reach).
    port: () => Number(new URL(base()).port),
    // When ion stops a tool call it asks you; made here, answered through the decisions made below.
    askBlocked: {
      ask: (r: AskingRun, b: Blocked) =>
        late.decisions?.askBlocked(runScopeOf(r), b) ?? Promise.resolve("timeout" as const),
      allowed: (r: AskingRun, key: string) =>
        late.decisions?.alwaysAllowed(r.projectId, r.chatId, key) ?? false,
      never: (r: AskingRun, key: string) => late.decisions?.saidNever(r.projectId, r.chatId, key) ?? null,
    },
  };
}

/** The data folder, the event store and the services every connection shares. */
function openState(
  opts: { dataDir: string; configFile: string; secrets?: Secrets; net?: Net; home?: string },
  base: () => string,
): { ctx: Ctx; turns: IonTurns } {
  const { db, store, memory, record } = openStore(opts.dataDir);
  // Made after the run manager it needs; the judge, the gate and runs' questions reach it through this holder.
  const late: { decisions?: Decisions } = {};
  const { tools, oauth, skills, forRuns, cli, ionBin } = connectionsOf(opts, store, late);
  const needs = new NeedsService(store, db);
  const grants = createGrants();
  const quick = harnessRunner({ ...opts, record });
  // How ion itself thinks (ion chief, the project ions, answering from your decisions): [ion] quick in Settings.
  const ionQuick = harnessRunner({ ...opts, record }, "quick");
  const ionQuestions = new IonQuestions({ store, db, needs, same: createSame(ionQuick) });
  sweepNeeds(needs, ionQuestions);
  const unsure = new UnsureLog(join(opts.dataDir, "unsure.json"));
  const access = autoAccess(opts, quick, late, unsure);
  const hooks = startHooks({ store, db, opts, tools }, { grants, base, ...(ionBin ? { bin: ionBin } : {}) });
  const servers = serversFor({ tools, oauth, configFile: opts.configFile });
  // Your servers for ions' turns: only what reads, as Auto's judge agrees (the user, 2026-11-21).
  const ownNames = (agent: string) => ownServerNames({ tools, skills, configFile: opts.configFile }, agent);
  const onUnsure = (c: GateCall) => {
    const note = unsure.add({ ...c, input: c.input });
    if (note) console.warn(note);
  };
  const ionServers = new IonServers({ ...opts, servers, judge: judgeOn(opts, quick), ownNames, onUnsure });
  const runCtx = runCtxOf({ opts, base, late, grants, hooks, picks: { tools, skills, ionServers }, memory });
  // Said once in the daemon's log when this computer can't sandbox chats' agents; ion's own git runs sandboxed too.
  const sandbox = startOwnAgents(opts, startSandbox(opts));
  const runs = new RunManager(store, { ...runCtx, access, ionBin, sandbox, servers, ...forRuns }, needs, db);
  // Your answer to an agent's question goes back into its chat as the next message, on the chat's harness.
  const decisions = new Decisions({
    ...{ store, db, needs },
    match: createMatcher(ionQuick),
    ion: ionQuestions,
    followUp: async (chatId, m) =>
      (await runs.ask(followAsk(chatId, m), { request: m.request, shown: m.shown, answers: m.answers }))
        .runId,
    requestOf: (runId) => runs.requestOf(runId),
  });
  late.decisions = decisions;
  const { ions, turns, dreams } = startIons({ store, db, ...opts, runs, grants, base, ionServers, memory });
  // A routine's time came (or you ran it now): its ion starts its thread.
  const routines = new Routines({
    ...{ store, db, configFile: opts.configFile },
    start: (projectId, r, by) => ions.routine(projectId, r, by),
  });
  const suggestions = chiefSuggestions({ store, db, configFile: opts.configFile, runs, routines, memory });
  const base0 = {
    ...{ configFile: opts.configFile, startedAt: Date.now(), version: VERSION },
    ...{ tools, oauth, unsure, ionServers, memory, dreams },
  };
  const shared = { store, db, needs, decisions, grants, runs, ions, routines, suggestions, ...base0, ...cli };
  const ctx = { ...shared, hooks, skills, queue: promptQueue({ ...shared, hooks, skills }) };
  return { ctx, turns };
}
