import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { type McpSpec, type RunSandbox, sandboxed, withPaths } from "@ion/adapter-kit";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
  McpError,
  ResultSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import { GroupTransport } from "./group-transport.js";

/** One of your local servers, as mcp.json runs it (its `${NAME}`s filled). */
export type StdioSpec = McpSpec & { transport: "stdio" };

/** A local server as ion's gateway reaches it: a message (already gated) in, its answer out; null: none is owed. */
type LocalServer = { send(message: unknown): Promise<unknown> };

/** A run's local servers: each by its name, and stopping them all (at the run's end, or when ion stops). */
export type RunBridges = { get(name: string): LocalServer | null; close(): Promise<void> };

/** Why a server went: it never started, stopped by itself, or sent ion too much at once (ion stopped it). */
export type Why = "start" | "crash" | "noisy";

export type BridgeOpts = {
  /**
   * The empty folder ion owns that the run's servers start in (made 0700 at the first start, removed when the run
   * ends); never the chat's worktree, where the agent could plant a `.npmrc`, `node_modules` or `x.py` they'd load.
   */
  folder: string;
  /** The chat's folder: what `${ION_WORKTREE}` in a server's command, args or env is filled with. */
  worktree?: string;
  /** Said once per server: it couldn't start, or stopped by itself. Never when the run ends it. */
  stopped(name: string, why: Why): void;
  /** The run's redaction: a server's error text passes it before the agent reads it. */
  redact?: <T>(data: T) => T;
  /** Where ion records its servers' process groups (swept at its next start). */
  groups?: string;
  /** The OS sandbox its servers run in (ion's folders denied); each may also read and write its own folder. */
  sandbox?: RunSandbox;
};

/** Starting (the process and its MCP handshake), at most this long: `npx` may download the server first. */
const START_MS = 60_000;
/** One request, at most this long (a tool can take a while); progress doesn't extend it. */
const CALL_MS = 10 * 60_000;

type Message = { id?: unknown; method?: unknown; params?: unknown };
type Id = string | number;

const rpcError = (id: Id, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

/** What a server needs from ion's environment to run (its tools, home, locale, temp folder, proxy); nothing more. */
const SERVER_ENV = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TERM",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
]);
const needed = (name: string) => SERVER_ENV.has(name.toUpperCase()) || name.startsWith("LC_");

/**
 * The environment a local server starts with: the few variables it needs to run, and its own filled values;
 * nothing else of ion's (none of your other keys, none of ion's own, no agent's config folder or SSH agent).
 */
function serverEnv(spec: StdioSpec, cwd: string): Record<string, string> {
  const base = Object.entries(process.env).filter(
    (e): e is [string, string] => e[1] !== undefined && needed(e[0]),
  );
  return { ...Object.fromEntries(base), PWD: cwd, ...spec.env };
}

/** `${ION_WORKTREE}` written in mcp.json, as it reaches ion's bridge (left unfilled until the run). */
const WORKTREE_REF = /\$\{ION_WORKTREE\}/g;

/** The server with `${ION_WORKTREE}` filled with the chat's folder (yours only: a repo's that names it is left out). */
function withWorktree(spec: StdioSpec, worktree = ""): StdioSpec {
  const fill = (t: string) => t.replace(WORKTREE_REF, () => worktree);
  const env = Object.fromEntries(Object.entries(spec.env).map(([k, v]) => [k, fill(v)]));
  return { ...spec, command: fill(spec.command), args: spec.args.map(fill), env };
}

/** The run's folder for its servers, made empty and 0700 (once per run, at its first server's start). */
function folderMaker(folder: string): () => void {
  let made = false;
  return () => {
    if (made) return;
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    chmodSync(folder, 0o700);
    made = true;
  };
}

const idOf = (m: Message): Id | null => (typeof m.id === "string" || typeof m.id === "number" ? m.id : null);

/** The server's capabilities less what ion doesn't pass on: list changes, subscriptions and logs. */
function forwarded(caps: ServerCapabilities = {}): Record<string, object> {
  const out: Record<string, object> = {};
  for (const k of ["tools", "resources", "prompts", "completions"] as const)
    if (caps[k])
      out[k] = Object.fromEntries(
        Object.entries(caps[k] as object).filter(([n]) => n !== "listChanged" && n !== "subscribe"),
      );
  return out;
}

/** ion's answer to the agent's handshake: the server's own name and instructions, and what ion passes on of it. */
function handshake(c: Client, params: unknown, name: string) {
  const asked = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
  const instructions = c.getInstructions();
  return {
    protocolVersion:
      typeof asked === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(asked)
        ? asked
        : LATEST_PROTOCOL_VERSION,
    capabilities: forwarded(c.getServerCapabilities()),
    serverInfo: c.getServerVersion() ?? { name, version: "0" },
    ...(instructions ? { instructions } : {}),
  };
}

/**
 * One local server for one run, started on the agent's first request (its MCP handshake), so a run whose agent never
 * connects starts nothing. ion is its MCP client: it does the handshake once, sends the agent's requests on one at
 * a time with its own ids (the agent's cancel goes on too), and answers the agent's handshake itself. What the
 * server asks of its client (sampling, roots, elicitation) is refused (ion offers none of these to your servers);
 * its notifications (progress, logs, list changes) aren't passed on. A server that fails to start or stops by
 * itself is said once; every request after gets a JSON-RPC error.
 */
class Local implements LocalServer {
  private started: Promise<Client | null> | undefined;
  private transport: GroupTransport | undefined;
  private ending = false;
  private gone: Why | null = null;
  /** The request going on now: the next waits for it. */
  private queue: Promise<unknown> = Promise.resolve();
  /** The agent's requests going on or waiting, by the agent's id: its cancel aborts them. */
  private readonly running = new Map<Id, AbortController>();

  constructor(
    private readonly spec: StdioSpec,
    private readonly o: BridgeOpts,
    private readonly makeFolder: () => void,
  ) {}

  private get down() {
    const n = this.spec.name;
    if (this.gone === "noisy") return `${n} sent too much, so ion stopped it`;
    return this.gone === "start"
      ? `${n} couldn't start, so ion can't reach it`
      : `${n} stopped, so ion can't reach it`;
  }

  /** Why it stopped by itself: it sent too much (ion stopped it), else it crashed. */
  private get stoppedWhy(): Why {
    return this.transport?.tooMuch ? "noisy" : "crash";
  }

  /** It couldn't start or stopped by itself: said once, never when the run ends it. */
  private fail(why: Why): void {
    if (this.ending || this.gone) return;
    this.gone = why;
    this.o.stopped(this.spec.name, why);
  }

  /** Where it runs: ion's own folder for the run; a repo's server you allowed here, the project's own folder. */
  private cwd(): string {
    return this.spec.cwd ?? this.o.folder;
  }

  private async start(): Promise<Client | null> {
    try {
      this.makeFolder();
    } catch {
      this.fail("start");
      return null;
    }
    // In the sandbox (Plan 18 Task 12): away from ion's folders, in its own (where ion starts it).
    const run = sandboxed(
      withPaths(this.o.sandbox, { write: [this.o.folder] }),
      this.spec.command,
      this.spec.args,
    );
    const t = new GroupTransport({
      command: run.command,
      args: run.args,
      env: serverEnv(this.spec, this.cwd()),
      cwd: this.cwd(),
      ...(this.o.groups ? { groups: this.o.groups } : {}),
    });
    this.transport = t;
    const client = new Client({ name: "ion", version: "1.0.0" }, { capabilities: {} });
    let up = false;
    client.onclose = () => this.fail(up ? this.stoppedWhy : "start");
    try {
      await client.connect(t, { timeout: START_MS });
      up = true;
      return this.ending ? null : client;
    } catch {
      this.fail("start");
      await t.close();
      return null;
    }
  }

  /** ion's client, started on first use; null once it failed, stopped or the run ended. */
  private async client(): Promise<Client | null> {
    if (this.ending || this.gone) return null;
    this.started ??= this.start();
    const c = await this.started;
    return this.gone ? null : c;
  }

  /** The server's error, its text through the run's redaction. */
  private said(id: Id, e: McpError) {
    const message = this.o.redact ? this.o.redact(e.message) : e.message;
    return rpcError(id, e.code, message);
  }

  /** A request sent on with ion's client's own id, after the one before it. */
  private request(c: Client, id: Id, m: Message & { method: string }): Promise<unknown> {
    const abort = new AbortController();
    this.running.set(id, abort);
    const params = m.params as Record<string, unknown> | undefined;
    const req = { method: m.method, ...(params ? { params } : {}) };
    const go = async () => {
      try {
        if (abort.signal.aborted) return rpcError(id, -32800, "Cancelled");
        const result = await c.request(req, ResultSchema, { timeout: CALL_MS, signal: abort.signal });
        return { jsonrpc: "2.0", id, result };
      } catch (e) {
        return this.failed(id, e, abort.signal.aborted);
      } finally {
        this.running.delete(id);
      }
    };
    const answer = this.queue.then(go);
    this.queue = answer;
    return answer;
  }

  private failed(id: Id, e: unknown, cancelled: boolean) {
    if (cancelled) return rpcError(id, -32800, "Cancelled");
    // The connection closed mid-request (it crashed): said once, like any stop.
    if (e instanceof McpError && e.code === ErrorCode.ConnectionClosed) this.fail(this.stoppedWhy);
    if (this.gone || this.ending) return rpcError(id, -32000, this.down);
    return e instanceof McpError ? this.said(id, e) : rpcError(id, -32000, `${this.spec.name} didn't answer`);
  }

  /** The agent's cancel: the request it names stops (sent: the server is told; waiting: never sent). */
  private cancel(params: unknown): void {
    const id = (params as { requestId?: unknown } | undefined)?.requestId;
    if (typeof id === "string" || typeof id === "number") this.running.get(id)?.abort("Cancelled");
  }

  async send(message: unknown): Promise<unknown> {
    const m = (message ?? {}) as Message;
    const id = idOf(m);
    if (m.method === "notifications/cancelled") this.cancel(m.params);
    // A notification (ion's client sent its own `initialized`) or an answer to a request ion already refused.
    if (id === null || typeof m.method !== "string") return null;
    if (m.method === "ping") return { jsonrpc: "2.0", id, result: {} };
    const c = await this.client();
    if (!c) return rpcError(id, -32000, this.down);
    if (m.method === "initialize")
      return { jsonrpc: "2.0", id, result: handshake(c, m.params, this.spec.name) };
    return this.request(c, id, { ...m, method: m.method });
  }

  async close(): Promise<void> {
    this.ending = true;
    for (const a of this.running.values()) a.abort("Cancelled");
    await this.transport?.close();
  }
}

/**
 * A run's local servers, each its own process group (two runs never share one), in the run's own folder (removed
 * once they've stopped).
 */
export function bridgesFor(specs: StdioSpec[], o: BridgeOpts): RunBridges {
  const make = folderMaker(o.folder);
  const servers = new Map(specs.map((s) => [s.name, new Local(withWorktree(s, o.worktree), o, make)]));
  return {
    get: (name) => servers.get(name) ?? null,
    async close() {
      await Promise.all([...servers.values()].map((s) => s.close()));
      if (servers.size) rmSync(o.folder, { recursive: true, force: true });
    },
  };
}
