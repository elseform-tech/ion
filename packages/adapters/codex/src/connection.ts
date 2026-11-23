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
  realForms,
  RpcError,
  type RunSandbox,
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
  sandbox?: RunSandbox;
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
const baseArgs = (l: Launch) => [
  ...BASE_ARGS,
  ...(l.ownTools ? [] : ["-c", "features.plugins=false"]),
  ...sandboxArgs(l.sandbox),
];

const PROFILE = "ion-run";

/**
 * In a run's sandbox, Codex declines by itself every request to run outside it (task review, 2026-11-21: an escalation
 * reached ion as a plain command approval). Given as config: as a thread parameter Codex 0.153.2 refused it (live,
 * "granular requires experimentalApi capability").
 */
const GRANULAR =
  "approval_policy={granular={sandbox_approval=false,rules=true,mcp_elicitations=true,request_permissions=false,skill_approval=false}}";

/**
 * A chat's run in Codex's own sandbox with ion's folders out of reach (docs/research/sandbox.md): a permission
 * profile on top of its workspace one (writes only in the worktree), ion's folders "none" (no read, no write), the
 * run's own paths let through, the agent's config read-only, the network on as for ion's other agents. Paths only:
 * nothing secret on the command line.
 */
function sandboxArgs(sb: RunSandbox | undefined): string[] {
  if (!sb || sb.kind === "none") return [];
  const p = sb.paths;
  const entries = [
    ...p.deny.flatMap(realForms).map((d) => [d, "none"]),
    ...[...p.read, ...p.noWrite].flatMap(realForms).map((d) => [d, "read"]),
    ...p.write.flatMap(realForms).map((d) => [d, "write"]),
  ];
  const fs = entries.map(([k, v]) => `${JSON.stringify(k)}=${JSON.stringify(v)}`).join(",");
  return [
    ...["-c", GRANULAR],
    ...["-c", `default_permissions="${PROFILE}"`, "-c", `permissions.${PROFILE}.extends=":workspace"`],
    ...[
      "-c",
      `permissions.${PROFILE}.network={enabled=true}`,
      "-c",
      `permissions.${PROFILE}.filesystem={${fs}}`,
    ],
  ];
}

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

type CodexConfig = { mcp_servers?: unknown; model?: unknown };

/** Codex's own config for this folder (its config.toml, a project's); null when it can't say. */
async function readConfig(rpc: Rpc, cwd: string | undefined): Promise<CodexConfig | null> {
  const r = (await rpc.request("config/read", cwd ? { cwd } : {}).catch(() => null)) as {
    config?: CodexConfig;
  } | null;
  return r ? (r.config ?? {}) : null;
}

/**
 * The servers Codex would load itself for this folder (its config.toml, a project's). Codex has no switch that turns
 * them all off, so when it can't say (config/read fails), a chat doesn't start (task review, 2026-11-21: it quietly
 * ran with your own servers); ion's judge (bare, read-only) goes on with none named.
 */
function ownServers(config: CodexConfig | null, opts: StartOpts): string[] {
  // Codex brings its own: none turned off, nothing to read.
  if (opts.ownTools) return [];
  if (!config && !opts.bare) throw new Error("ion couldn't turn off Codex's own servers");
  const servers = config?.mcp_servers;
  return servers && typeof servers === "object" ? Object.keys(servers) : [];
}

// ---- models: only those this sign-in can use ---------------------------------------------------------------

type Listed = { id: string; displayName?: unknown; hidden?: unknown; isDefault?: unknown };

export const cantUse = (model: string) => `Codex can't use ${model} with this sign-in`;

/** The models this sign-in can use (`model/list` answers per account; hidden ones too, they work). */
async function listModels(rpc: Rpc): Promise<Listed[]> {
  const r = (await rpc.request("model/list", { includeHidden: true, limit: 100 })) as {
    data?: { id?: unknown }[];
  };
  return (r.data ?? []).filter((m): m is Listed => typeof m.id === "string");
}

const listedHas = (listed: Listed[], model: unknown) => listed.some((m) => m.id === model);

/** What Codex uses with no model named: your config's when this sign-in can use it, else the one it marks default. */
function defaultOf(listed: Listed[], config: CodexConfig | null): string | null {
  if (listedHas(listed, config?.model)) return String(config!.model);
  return listed.find((m) => m.isDefault === true)?.id ?? null;
}

/**
 * The model a thread is opened with; undefined leaves it to Codex. Plan 20 builder, 2026-11-22: with none named,
 * Codex took your config.toml's model, which a ChatGPT sign-in couldn't use (model_not_found); ion names the
 * account's default then. A pick it can't use is refused before any turn. When Codex can't list, as asked.
 */
async function modelFor(rpc: Rpc, opts: StartOpts, config: CodexConfig | null): Promise<string | undefined> {
  const listed = await listModels(rpc).catch(() => null);
  if (!listed?.length) return opts.model ?? undefined;
  if (opts.model) {
    if (!listedHas(listed, opts.model)) throw new Error(cantUse(opts.model));
    return opts.model;
  }
  if (config?.model === undefined || listedHas(listed, config.model)) return undefined;
  return defaultOf(listed, config) ?? undefined;
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
    // In a run's sandbox the approval policy comes from config (sandboxArgs: GRANULAR); ion's gate judges every
    // command first either way.
    ...(sandboxedRun(opts) ? {} : { approvalPolicy: "untrusted" }),
    approvalsReviewer: "user",
    // In a run's sandbox, the permission profile (sandboxArgs) decides: a thread's own setting would replace it.
    ...(sandboxedRun(opts) ? {} : { sandbox: opts.bare ? "read-only" : "workspace-write" }),
    // Network on, as for ion's other agents: every command still goes through ion's gate and judge first, and
    // the gate's key is hidden from commands (HIDE_GATE); ion's MCP key is in the thread's config, not the env.
    config: {
      ...mcpConfig(opts.mcpServers, own),
      ...(sandboxedRun(opts) ? {} : { sandbox_workspace_write: { network_access: true } }),
      // No web (ion's dream): its own web search off, by the newer key and the older one.
      ...(opts.noWeb ? { web_search: "disabled", tools: { web_search: false } } : {}),
    },
    ...(opts.instructions ? { developerInstructions: opts.instructions } : {}),
    ...(opts.bare ? { ephemeral: true } : {}),
  };
}

const sandboxedRun = (opts: StartOpts) => !opts.bare && !!opts.sandbox && opts.sandbox.kind !== "none";

async function openThread(rpc: Rpc, opts: StartOpts): Promise<{ threadId: string; model: string }> {
  const config = await readConfig(rpc, opts.cwd);
  const model = await modelFor(rpc, opts, config);
  const params = threadParams({ ...opts, model: model ?? null }, ownServers(config, opts));
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
    model: typeof r.model === "string" ? r.model : (model ?? "default"),
  };
}

/** Starts Codex's app-server in the chat's folder (with ion's gate when the run has one) and opens a thread. */
export async function connect(l0: Launch, opts: StartOpts): Promise<Connection> {
  const l: Launch = {
    ...l0,
    ...(opts.envDrop ? { envDrop: opts.envDrop } : {}),
    ...(opts.ownTools ? { ownTools: true } : {}),
    ...(opts.sandbox && !opts.bare ? { sandbox: opts.sandbox } : {}),
  };
  const env: Record<string, string> = { ...opts.env, ...(opts.gate ? { ION_GATE_URL: opts.gate.url } : {}) };
  const io = opts.gate ? await withGate(l, opts.cwd, env) : spawnAppServer(l, [], env);
  return within(l, io, async () => {
    if (!opts.gate) await initialize(io.rpc);
    const method = await authMethod(io.rpc);
    return { ...io, ...(await openThread(io.rpc, opts)), authMethod: method };
  });
}

/**
 * Codex's models for this sign-in (`model/list`, hidden ones left out), from an app-server started without a thread;
 * the default is the one a chat with no pick gets (modelFor).
 */
export async function probeModels(l: Launch): Promise<Catalog> {
  const io = spawnAppServer(l, [], {});
  try {
    return await within(l, io, async () => {
      await initialize(io.rpc);
      const listed = await listModels(io.rpc);
      const shown = listed.filter((m) => m.hidden !== true);
      const models = shown.map((m) => ({ id: m.id, label: String(m.displayName ?? m.id) }));
      const def = defaultOf(listed, await readConfig(io.rpc, undefined));
      return { models, defaultModel: def && listedHas(shown, def) ? def : null };
    });
  } finally {
    io.child.kill();
  }
}
