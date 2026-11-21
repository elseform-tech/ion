import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
  agentEnv,
  type Catalog,
  createRpc,
  type EnvDrop,
  type HttpMcpSpec,
  ResumeFailed,
  type Rpc,
  RpcError,
  type StartOpts,
} from "@ion/adapter-kit";
import { type HookTrust, hookArgs, hookCommand } from "./gate.js";

/** How to start Codex: its binary, and anything before ion's own arguments (tests run a script with Node). */
/** `envDrop`: what a chat's Codex may not inherit from ion's environment (your keys). */
/** `ownTools`: Codex brings its own servers and plugins (a chat with "Use its own tools" on); its hooks stay off. */
export type Launch = {
  bin: string;
  prefix: string[];
  timeoutMs: number;
  envDrop?: EnvDrop;
  ownTools?: boolean;
};

export type Connection = {
  child: ChildProcessByStdio<Writable, Readable, null>;
  rpc: Rpc;
  threadId: string;
  model: string;
  /** How you signed in to Codex ("ChatGPT", "API key"), never who. */
  authMethod: string;
};

type Io = Pick<Connection, "child" | "rpc">;

/**
 * Always, under ion: no background memory agent (it runs tools of its own, outside the chat) and no question card
 * (nobody can answer it headless; agents ask through ion's ask tool).
 */
const BASE_ARGS = ["-c", "features.memories=false", "-c", "features.default_mode_request_user_input=false"];
/**
 * "Use its own tools" off: ion's tools only, so Codex's plugins (their servers and skills) stay Codex's own. On (the
 * user, 2026-11-21), they load; their hooks are turned off with Codex's others (withGate).
 */
const baseArgs = (l: Launch) => [...BASE_ARGS, ...(l.ownTools ? [] : ["-c", "features.plugins=false"])];

export const SIGNED_OUT = "Codex isn't signed in. Run: codex login";

/** Codex didn't answer in time (a first-run download, a prompt of its own, a hang). */
class NotResponding extends Error {}

function spawnAppServer(l: Launch, args: string[], env: Record<string, string>): Io {
  const child = spawn(l.bin, [...l.prefix, ...baseArgs(l), ...args, "app-server"], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...agentEnv(process.env, l.envDrop), ...env },
  });
  const rpc = createRpc({ stdin: child.stdin, stdout: child.stdout });
  child.on("error", () => child.stdout.destroy());
  child.on("exit", () => child.stdout.destroy());
  return { child, rpc };
}

async function initialize(rpc: Rpc): Promise<void> {
  await rpc.request("initialize", {
    clientInfo: { name: "ion", title: "ion", version: "0.0.0" },
    capabilities: null,
  });
  rpc.notify("initialized", {});
}

/** Starts Codex and runs `work`; stops Codex if it fails or takes longer than the launch allows. */
async function within<T>(l: Launch, io: Io, work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new NotResponding("Codex didn't respond")), l.timeoutMs);
  });
  try {
    return await Promise.race([work(), timeout]);
  } catch (e) {
    io.child.kill();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const METHODS: Record<string, string> = {
  chatgpt: "ChatGPT",
  apiKey: "API key",
  amazonBedrock: "Amazon Bedrock",
};

/** Signed in or not, and how; the account's details (an email) are read past, never kept. */
async function authMethod(rpc: Rpc): Promise<string> {
  const r = (await rpc.request("account/read", { refreshToken: false })) as {
    account?: { type?: unknown } | null;
    requiresOpenaiAuth?: unknown;
  };
  if (!r.account && r.requiresOpenaiAuth !== false) throw new Error(SIGNED_OUT);
  return METHODS[String(r.account?.type)] ?? "Signed in";
}

// ---- ion's gate hook: trusted by hash, learned once per Codex and hook ------------------------------------

type HookEntry = {
  key: string;
  command: string;
  source: string;
  enabled: boolean;
  isManaged?: boolean;
  currentHash: string;
  trustStatus: string;
};
const trusted = new Map<string, HookTrust>();
/** Your own hooks ion turned off last time, by Codex and hook: the next start tries those first. */
const turnedOff = new Map<string, string[]>();

/** ion's hook, and your own hooks that are on (your organization's managed ones are left as they are). */
async function listHooks(rpc: Rpc, cwd: string): Promise<{ ion: HookEntry | null; yours: string[] }> {
  const r = (await rpc.request("hooks/list", { cwds: [cwd] })) as { data?: { hooks?: HookEntry[] }[] };
  const hooks = (r.data ?? []).flatMap((d) => d.hooks ?? []);
  const ion = hooks.find((h) => h.source === "sessionFlags" && h.command === hookCommand()) ?? null;
  const yours = hooks
    .filter((h) => h.enabled && !h.isManaged && h.source !== "sessionFlags")
    .map((h) => h.key);
  return { ion, yours };
}

/**
 * The gate's address (its key included) reaches ion's hook through the environment, but the commands Codex runs
 * inherit that environment too: seen live, `printenv ION_GATE_URL` printed it. It's blanked for them (`set`,
 * applied after Codex's shell snapshot; `exclude` alone didn't hide it), and hooks still get it.
 */
const HIDE_GATE = ["-c", 'shell_environment_policy.set.ION_GATE_URL=""'];

/**
 * Codex with ion's PreToolUse hook running and your own hooks off. A hook runs only once its exact content is
 * trusted, so the first start asks Codex for the hook's hash (and which of your hooks are on) and starts again
 * trusting it, with yours off; later starts reuse both. Never runs without ion's hook.
 */
async function withGate(l: Launch, cwd: string, env: Record<string, string>): Promise<Io> {
  const cacheKey = `${l.bin} ${l.prefix.join(" ")} ${hookCommand()}`;
  let off = turnedOff.get(cacheKey) ?? [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const args = [...hookArgs(trusted.get(cacheKey) ?? null, off), ...HIDE_GATE];
    const io = spawnAppServer(l, args, env);
    const { ion, yours } = await within(l, io, async () => {
      await initialize(io.rpc);
      return listHooks(io.rpc, cwd);
    });
    if (ion?.trustStatus === "trusted" && ion.enabled && !yours.length) return io;
    io.child.kill();
    if (!ion) break;
    trusted.set(cacheKey, { key: ion.key, hash: ion.currentHash });
    off = [...new Set([...off, ...yours])];
    turnedOff.set(cacheKey, off);
  }
  throw new Error("Codex didn't accept ion's gate, so ion won't run it");
}

// ---- threads ------------------------------------------------------------------------------------------------

const EFFORT: Record<string, string> = { low: "low", medium: "medium", high: "high", max: "xhigh" };
export const effortOf = (e: StartOpts["effort"]) => (e ? EFFORT[e] : undefined);

/**
 * The run's MCP servers with their keys: sent over stdin in the thread's config, never in argv. Codex's own servers
 * (`own`) are each turned off: the thread's config merges into Codex's, so leaving them out wouldn't.
 */
function mcpConfig(servers: StartOpts["mcpServers"] = [], own: string[] = []): Record<string, unknown> {
  const of = (s: HttpMcpSpec) => ({ url: s.url, http_headers: s.headers });
  const ion = new Set(servers.map((s) => s.name));
  const off = own.filter((n) => !ion.has(n)).map((n) => [n, { enabled: false }]);
  if (!servers.length && !off.length) return {};
  return { mcp_servers: Object.fromEntries([...servers.map((s) => [s.name, of(s)]), ...off]) };
}

/**
 * The servers Codex would load itself for this folder (its config.toml, a project's). Codex has no switch that turns
 * them all off, so when it can't say (config/read fails), a chat doesn't start (task review, 2026-11-21: it quietly
 * ran with your own servers); ion's judge (bare, read-only) goes on with none named.
 */
async function ownServers(rpc: Rpc, opts: StartOpts): Promise<string[]> {
  // Codex brings its own: none turned off, nothing to read.
  if (opts.ownTools) return [];
  const { cwd, bare } = opts;
  const r = (await rpc.request("config/read", { cwd }).catch(() => null)) as {
    config?: { mcp_servers?: unknown };
  } | null;
  if (!r && !bare) throw new Error("ion couldn't turn off Codex's own servers");
  const servers = r?.config?.mcp_servers;
  return servers && typeof servers === "object" ? Object.keys(servers) : [];
}

/**
 * Every thread asks before tools ("untrusted": only Codex's own read-only commands would skip it, and those still
 * go through the gate), its approvals come to ion ("user", not Codex's auto-reviewer), and writes stay in the
 * worktree. ion's judge (bare) gets a throwaway, read-only thread.
 */
function threadParams(opts: StartOpts, own: string[]): Record<string, unknown> {
  return {
    cwd: opts.cwd,
    ...(opts.model ? { model: opts.model } : {}),
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    sandbox: opts.bare ? "read-only" : "workspace-write",
    // Network on, as for ion's other agents: every command still goes through ion's gate and judge first, and
    // the gate's key is hidden from commands (HIDE_GATE); ion's MCP key is in the thread's config, not the env.
    config: { ...mcpConfig(opts.mcpServers, own), sandbox_workspace_write: { network_access: true } },
    ...(opts.instructions ? { developerInstructions: opts.instructions } : {}),
    ...(opts.bare ? { ephemeral: true } : {}),
  };
}

async function openThread(rpc: Rpc, opts: StartOpts): Promise<{ threadId: string; model: string }> {
  const params = threadParams(opts, await ownServers(rpc, opts));
  let r: { thread?: { id?: unknown }; model?: unknown };
  try {
    r = (await (opts.resume
      ? rpc.request("thread/resume", { ...params, threadId: opts.resume, excludeTurns: true })
      : rpc.request("thread/start", params))) as typeof r;
  } catch (e) {
    if (opts.resume && e instanceof RpcError)
      throw new ResumeFailed("Codex couldn't continue this chat's thread");
    throw e;
  }
  return {
    threadId: String(r.thread?.id),
    model: typeof r.model === "string" ? r.model : (opts.model ?? "default"),
  };
}

/** Starts Codex's app-server in the chat's folder (with ion's gate when the run has one) and opens a thread. */
export async function connect(l0: Launch, opts: StartOpts): Promise<Connection> {
  const l: Launch = {
    ...l0,
    ...(opts.envDrop ? { envDrop: opts.envDrop } : {}),
    ...(opts.ownTools ? { ownTools: true } : {}),
  };
  const env: Record<string, string> = { ...opts.env, ...(opts.gate ? { ION_GATE_URL: opts.gate.url } : {}) };
  const io = opts.gate ? await withGate(l, opts.cwd, env) : spawnAppServer(l, [], env);
  return within(l, io, async () => {
    if (!opts.gate) await initialize(io.rpc);
    const method = await authMethod(io.rpc);
    return { ...io, ...(await openThread(io.rpc, opts)), authMethod: method };
  });
}

/** Codex's models (`model/list`, hidden ones left out), from an app-server started without a thread. */
export async function probeModels(l: Launch): Promise<Catalog> {
  const io = spawnAppServer(l, [], {});
  try {
    return await within(l, io, async () => {
      await initialize(io.rpc);
      const r = (await io.rpc.request("model/list", { includeHidden: false, limit: 100 })) as {
        data?: { id?: unknown; displayName?: unknown; hidden?: unknown; isDefault?: unknown }[];
      };
      const shown = (r.data ?? []).filter((m) => typeof m.id === "string" && m.hidden !== true);
      const models = shown.map((m) => ({ id: String(m.id), label: String(m.displayName ?? m.id) }));
      const def = shown.find((m) => m.isDefault === true);
      return { models, defaultModel: def ? String(def.id) : null };
    });
  } finally {
    io.child.kill();
  }
}
