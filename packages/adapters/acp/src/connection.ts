import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentEnv,
  type Catalog,
  createRpc,
  type HttpMcpSpec,
  ResumeFailed,
  type Rpc,
  RpcError,
  type RunSandbox,
  sandboxed,
  type StartOpts,
  withPaths,
} from "@ion/adapter-kit";
import type { AcpHarness } from "./harnesses.js";

type Choice = { value?: unknown; name?: unknown; options?: Choice[] };
type ConfigOption = { id: string; category?: string; currentValue?: unknown; options?: Choice[] };
/** The agent's process as a session sees it: a real one, or one session of ion's warm judge (bare.ts). */
type AgentChild = { kill(): unknown; on(event: "exit", listener: () => void): unknown };
export type Connection = {
  child: AgentChild;
  rpc: Rpc;
  sessionId: string;
  options: ConfigOption[];
  /** The last reason the agent's own log gave for a failed turn (harnesses with `logFailure`). */
  failure?: () => string | undefined;
};

/** Spawns the agent (never through a shell), initializes ACP and opens a session in `cwd`. */
export type ConnectOpts = {
  cwd: string;
  timeoutMs?: number;
  resume?: string | null;
  mcpServers?: StartOpts["mcpServers"];
  gate?: StartOpts["gate"];
  env?: StartOpts["env"];
  envDrop?: StartOpts["envDrop"];
  ownTools?: StartOpts["ownTools"];
  sandbox?: StartOpts["sandbox"];
  /** Its command line instead of the harness's (a bare start's, or one with no web). */
  args?: string[];
  /** Set after the harness's own environment (a start with no web: its own config folder). */
  lastEnv?: Record<string, string>;
};

/** Starts of an agent that's setting up, by agent: they take turns (two at once slowed each other past the limit). */
const settingUp = new Map<string, Promise<unknown>>();

export function connect(h: AcpHarness, bin: string, o: ConnectOpts): Promise<Connection> {
  if (!h.notResponding?.(o.ownTools)) return open(h, bin, o);
  const before = settingUp.get(h.id) ?? Promise.resolve();
  const mine = before.then(() => open(h, bin, o));
  settingUp.set(
    h.id,
    mine.catch(() => {}),
  );
  return mine;
}

/** A started agent process: its JSON-RPC, and its log's last failure reason (harnesses with `logFailure`). */
export type Spawned = {
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  rpc: Rpc;
  failure?: () => string | undefined;
};

/** Spawns the agent (never through a shell) in the run's sandbox, with the agent's own paths added. */
export function spawnAgent(h: AcpHarness, bin: string, o: ConnectOpts): Spawned {
  // In a run's sandbox (with the agent's own paths), so every process it starts is too.
  const sb = withPaths(o.sandbox, h.sandboxPaths?.(o.ownTools) ?? {});
  const run = sandboxed(sb, bin, o.args ?? h.args);
  const child = spawn(run.command, run.args, { stdio: ["pipe", "pipe", "pipe"], env: envOf(h, o) });
  const rpc = createRpc({ stdin: child.stdin, stdout: child.stdout });
  // Gone (or never started): its output ends, so nothing waits on it.
  for (const gone of ["error", "exit"] as const) child.on(gone, () => child.stdout.destroy());
  // Its log is read only where it can say why a turn failed; otherwise it's drained unread.
  const failure = h.logFailure ? lastFailure(child.stderr, h.logFailure) : void child.stderr.resume();
  return failure ? { child, rpc, failure } : { child, rpc };
}

/** `work`, or NotResponding once the start's time is up. */
export async function inTime<T>(h: AcpHarness, o: ConnectOpts, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    const why = h.notResponding?.(o.ownTools) ?? `${h.label} didn't respond`;
    timer = setTimeout(() => reject(new NotResponding(why)), o.timeoutMs ?? 30_000);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function open(h: AcpHarness, bin: string, o: ConnectOpts): Promise<Connection> {
  const a = spawnAgent(h, bin, o);
  try {
    const session = async () => openSession(h, a.rpc, await initialize(a.rpc), o);
    return { ...a, ...(await inTime(h, o, session())) };
  } catch (e) {
    a.child.kill();
    throw startError(h, o, e);
  }
}

/** The agent's environment: ion's (less your keys), the run's, and the harness's own (its gate, its config). */
const envOf = (h: AcpHarness, o: ConnectOpts) => ({
  ...agentEnv(process.env, o.envDrop),
  ...o.env,
  ...(h.env?.(o.gate ? { url: o.gate.url, cwd: o.cwd } : undefined, !!o.ownTools) ?? {}),
  ...o.lastEnv,
});

/** What a start that failed says: not signed in, a session it couldn't continue, or the error as it was. */
export function startError(h: AcpHarness, o: ConnectOpts, e: unknown): unknown {
  if (e instanceof RpcError && e.code === -32000)
    return new Error(`${h.label} isn't signed in. Run: ${h.loginHint}`);
  if (o.resume && e instanceof RpcError)
    return new ResumeFailed(`${h.label} couldn't continue this chat's session`);
  return e;
}

/** Reads the agent's log as it comes (never letting it fill up): the last failure reason it gave. */
function lastFailure(stderr: Readable, read: (line: string) => string | null): () => string | undefined {
  let last: string | undefined;
  let rest = "";
  stderr.setEncoding("utf8");
  stderr.on("data", (chunk: string) => {
    const lines = (rest + chunk).split("\n");
    rest = (lines.pop() ?? "").slice(-8192);
    for (const line of lines) last = read(line) ?? last;
  });
  stderr.on("error", () => {});
  return () => last;
}

/** The agent didn't answer in time (first-run download, an interactive prompt, a hang). */
class NotResponding extends Error {}

export type AgentCaps = {
  loadSession?: boolean;
  sessionCapabilities?: { resume?: object; close?: object };
  mcpCapabilities?: { http?: boolean };
};

const pairs = (o: Record<string, string>) => Object.entries(o).map(([name, value]) => ({ name, value }));

/**
 * The run's MCP servers in ACP's shape, inside the session request (over stdin, never the agent's command line).
 * Every server is remote (ion's URL for it), passed only when the agent's `initialize` says it takes them.
 */
function acpServers(servers: HttpMcpSpec[] = [], caps: AgentCaps): unknown[] {
  return servers.flatMap((s): unknown[] => {
    return caps.mcpCapabilities?.http
      ? [{ type: "http", name: s.name, url: s.url, headers: pairs(s.headers) }]
      : [];
  });
}

/** ACP's `initialize`: what the agent can do. */
export async function initialize(rpc: Rpc): Promise<AgentCaps> {
  const init = (await rpc.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "ion", version: "0.0.0" },
  })) as { agentCapabilities?: AgentCaps };
  return init.agentCapabilities ?? {};
}

/** Opens (or continues) a session in `o.cwd` on a started agent. */
export async function openSession(
  h: AcpHarness,
  rpc: Rpc,
  caps: AgentCaps,
  o: ConnectOpts,
): Promise<{ sessionId: string; options: ConfigOption[] }> {
  const mcpServers = acpServers(o.mcpServers, caps);
  const base = { cwd: o.cwd, mcpServers, ...(h.sessionMeta ? { _meta: h.sessionMeta } : {}) };
  if (o.resume) {
    const method = continueMethod(caps);
    if (!method) throw new ResumeFailed(`${h.label} can't continue sessions`);
    // session/load replays the old conversation as updates; nothing listens yet, so it isn't shown again.
    const r = (await rpc.request(method, { ...base, sessionId: o.resume })) as {
      configOptions?: ConfigOption[];
    };
    return { sessionId: o.resume, options: r?.configOptions ?? [] };
  }
  const s = (await rpc.request("session/new", base)) as {
    sessionId: string;
    configOptions?: ConfigOption[];
  };
  return { sessionId: s.sessionId, options: s.configOptions ?? [] };
}

/** session/resume when the agent offers it (no replay), else session/load, else none. */
function continueMethod(caps: AgentCaps): "session/resume" | "session/load" | null {
  if (caps.sessionCapabilities?.resume) return "session/resume";
  return caps.loadSession ? "session/load" : null;
}

/**
 * Opens the agent once outside the sandbox, with no prompt, gate or servers, so it sets itself up in ion's folder for
 * it (opencode installs its plugin package there) before a run starts it sandboxed, where that folder is read-only.
 * A failure here is the run's start to report.
 */
export async function setUpOutside(
  h: AcpHarness,
  bin: string,
  o: { ownTools?: boolean; timeoutMs?: number },
) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ion-setup-")));
  try {
    const c = await connect(h, bin, {
      cwd: dir,
      timeoutMs: o.timeoutMs,
      ...(o.ownTools ? { ownTools: true } : {}),
    });
    c.child.kill();
  } catch {
    // the sandboxed start says what's wrong
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Where and how ion's checks of an agent (sign-in, models) open it: a folder under `root` (ion's data folder, denied to
 * every run) and the sandbox the daemon gives for that folder (final review, 2026-11-22: they ran outside it, in
 * $TMPDIR, where a plugin a run had planted ran unsandboxed). Only opencode's first setup stays outside.
 */
export type ProbePlace = {
  root?: string;
  sandbox?: (cwd: string, harness: string) => RunSandbox | undefined;
};

/** Opens the agent for a check (no prompt) where `place` says, hands the connection to `use`, and cleans up. */
async function probing<T>(
  h: AcpHarness,
  bin: string,
  o: { timeoutMs?: number; place?: ProbePlace },
  use: (c: Connection) => T,
): Promise<T> {
  const root = o.place?.root ?? tmpdir();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = realpathSync(mkdtempSync(join(root, "ion-probe-")));
  try {
    const sandbox = o.place?.sandbox?.(dir, h.id);
    // Not set up yet (opencode's plugin package): once outside the sandbox first, as a run's start does.
    if (sandbox && h.prepare && !h.prepare()) await setUpOutside(h, bin, { timeoutMs: o.timeoutMs });
    const at: ConnectOpts = { cwd: dir, timeoutMs: o.timeoutMs, ...(sandbox ? { sandbox } : {}) };
    const c = await connect(h, bin, at);
    c.child.kill();
    // Its session goes from the agent's history (final review, 2026-11-22: Grok kept every check's).
    forget(h, bin, at, c.sessionId);
    return use(c);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Opens a session without sending a prompt: signed in, signed out, or not responding. Cleans up after itself. */
export async function probeSignedIn(
  h: AcpHarness,
  bin: string,
  o: { timeoutMs?: number; place?: ProbePlace } = {},
): Promise<"yes" | "no" | "not-responding"> {
  try {
    return await probing(h, bin, o, () => "yes" as const);
  } catch (e) {
    return e instanceof NotResponding ? "not-responding" : "no";
  }
}

/** The agent's models: the choices of its model option (groups flattened), from a session opened without a prompt. */
export async function probeModels(
  h: AcpHarness,
  bin: string,
  o: { timeoutMs?: number; place?: ProbePlace } = {},
): Promise<Catalog> {
  return probing(h, bin, o, (c) => {
    const opt = c.options.find((x) => x.category === "model");
    const flat = (cs: Choice[]): Choice[] =>
      cs.flatMap((x) => (Array.isArray(x.options) ? flat(x.options) : [x]));
    const models = flat(opt?.options ?? [])
      .filter((x) => typeof x.value === "string")
      .map((x) => ({ id: String(x.value), label: typeof x.name === "string" ? x.name : String(x.value) }));
    const current = typeof opt?.currentValue === "string" ? opt.currentValue : null;
    return { models, defaultModel: h.defaultModel ?? current };
  });
}

/** Sets a session config option of the given category (model, thought_level) when the agent offers one. */
export async function setOption(
  c: Connection,
  category: string,
  value: string | null,
): Promise<string | null> {
  const opt = c.options.find((o) => o.category === category);
  if (!opt) return null;
  if (value) {
    await c.rpc
      .request("session/set_config_option", { sessionId: c.sessionId, configId: opt.id, value })
      .catch(() => {});
    return value;
  }
  return typeof opt.currentValue === "string" ? opt.currentValue : null;
}

/**
 * Has the agent delete a judge's (or a check's) session from its history (Grok: `grok sessions delete`; opencode: `opencode session
 * delete`), so ion's verdicts don't pile up among your own sessions. In the same sandbox; its failure changes nothing.
 */
export function forget(h: AcpHarness, bin: string, o: ConnectOpts, sessionId: string): void {
  const args = h.forgetArgs?.(sessionId);
  if (!args) return;
  const run = sandboxed(withPaths(o.sandbox, h.sandboxPaths?.() ?? {}), bin, args);
  const env = { ...agentEnv(process.env, o.envDrop), ...o.env };
  // Not in the session's folder: it may be gone by now.
  const child = spawn(run.command, run.args, { stdio: "ignore", env });
  child.on("error", () => {});
  child.unref();
}
