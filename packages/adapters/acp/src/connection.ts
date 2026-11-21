import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
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
  sandboxed,
  type StartOpts,
  withPaths,
} from "@ion/adapter-kit";
import type { AcpHarness } from "./harnesses.js";

type Choice = { value?: unknown; name?: unknown; options?: Choice[] };
type ConfigOption = { id: string; category?: string; currentValue?: unknown; options?: Choice[] };
export type Connection = {
  child: ChildProcessByStdio<Writable, Readable, Readable>;
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

async function open(h: AcpHarness, bin: string, o: ConnectOpts): Promise<Connection> {
  const timeoutMs = o.timeoutMs ?? 30_000;
  // In a run's sandbox (with the agent's own paths), so every process it starts is too.
  const sb = withPaths(o.sandbox, h.sandboxPaths?.(o.ownTools) ?? {});
  const run = sandboxed(sb, bin, h.args);
  const child = spawn(run.command, run.args, { stdio: ["pipe", "pipe", "pipe"], env: envOf(h, o) });
  const rpc = createRpc({ stdin: child.stdin, stdout: child.stdout });
  // Gone (or never started): its output ends, so nothing waits on it.
  for (const gone of ["error", "exit"] as const) child.on(gone, () => child.stdout.destroy());
  // Its log is read only where it can say why a turn failed; otherwise it's drained unread.
  const failure = h.logFailure ? lastFailure(child.stderr, h.logFailure) : void child.stderr.resume();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    const why = h.notResponding?.(o.ownTools) ?? `${h.label} didn't respond`;
    timer = setTimeout(() => reject(new NotResponding(why)), timeoutMs);
  });
  try {
    const c = await Promise.race([handshake(h, { rpc, child }, o), timeout]);
    return failure ? { ...c, failure } : c;
  } catch (e) {
    child.kill();
    throw startError(h, o, e);
  } finally {
    clearTimeout(timer);
  }
}

/** The agent's environment: ion's (less your keys), the run's, and the harness's own (its gate, its config). */
const envOf = (h: AcpHarness, o: ConnectOpts) => ({
  ...agentEnv(process.env, o.envDrop),
  ...o.env,
  ...(h.env?.(o.gate ? { url: o.gate.url, cwd: o.cwd } : undefined, !!o.ownTools) ?? {}),
});

/** What a start that failed says: not signed in, a session it couldn't continue, or the error as it was. */
function startError(h: AcpHarness, o: ConnectOpts, e: unknown): unknown {
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

type AgentCaps = {
  loadSession?: boolean;
  sessionCapabilities?: { resume?: object };
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

async function handshake(
  h: AcpHarness,
  io: Pick<Connection, "rpc" | "child">,
  o: ConnectOpts,
): Promise<Connection> {
  const init = (await io.rpc.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "ion", version: "0.0.0" },
  })) as { agentCapabilities?: AgentCaps };
  const mcpServers = acpServers(o.mcpServers, init.agentCapabilities ?? {});
  const base = { cwd: o.cwd, mcpServers, ...(h.sessionMeta ? { _meta: h.sessionMeta } : {}) };
  if (o.resume) {
    const method = continueMethod(init.agentCapabilities ?? {});
    if (!method) throw new ResumeFailed(`${h.label} can't continue sessions`);
    // session/load replays the old conversation as updates; nothing listens yet, so it isn't shown again.
    const r = (await io.rpc.request(method, { ...base, sessionId: o.resume })) as {
      configOptions?: ConfigOption[];
    };
    return { ...io, sessionId: o.resume, options: r?.configOptions ?? [] };
  }
  const s = (await io.rpc.request("session/new", base)) as {
    sessionId: string;
    configOptions?: ConfigOption[];
  };
  return { ...io, sessionId: s.sessionId, options: s.configOptions ?? [] };
}

/** session/resume when the agent offers it (no replay), else session/load, else none. */
function continueMethod(caps: AgentCaps): "session/resume" | "session/load" | null {
  if (caps.sessionCapabilities?.resume) return "session/resume";
  return caps.loadSession ? "session/load" : null;
}

/** Opens a session without sending a prompt: signed in, signed out, or not responding. Cleans up after itself. */
export async function probeSignedIn(
  h: AcpHarness,
  bin: string,
  timeoutMs?: number,
): Promise<"yes" | "no" | "not-responding"> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ion-probe-")));
  try {
    const c = await connect(h, bin, { cwd: dir, timeoutMs });
    c.child.kill();
    return "yes";
  } catch (e) {
    return e instanceof NotResponding ? "not-responding" : "no";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The agent's models: the choices of its model option (groups flattened), from a session opened without a prompt. */
export async function probeModels(h: AcpHarness, bin: string, timeoutMs?: number): Promise<Catalog> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ion-probe-")));
  try {
    const c = await connect(h, bin, { cwd: dir, timeoutMs });
    c.child.kill();
    const opt = c.options.find((o) => o.category === "model");
    const flat = (cs: Choice[]): Choice[] =>
      cs.flatMap((x) => (Array.isArray(x.options) ? flat(x.options) : [x]));
    const models = flat(opt?.options ?? [])
      .filter((x) => typeof x.value === "string")
      .map((x) => ({ id: String(x.value), label: typeof x.name === "string" ? x.name : String(x.value) }));
    const current = typeof opt?.currentValue === "string" ? opt.currentValue : null;
    return { models, defaultModel: h.defaultModel ?? current };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
