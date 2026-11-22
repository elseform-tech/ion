import { join } from "node:path";
import { type EnvDrop, type HttpMcpSpec, ION_SERVER } from "@ion/adapter-kit";
import { EV } from "@ion/schema";
import type { HarnessEntry } from "../adapters/registry.js";
import type { EventStore } from "../store/index.js";
import { type LocalUpstream, type Upstream, upstreamOf } from "../gateway/index.js";
import { bridgesFor, type RunBridges, type StdioSpec, type Why } from "../workspace/mcp-bridge.js";
import { type RunAgent, type RunServers, SECRET_MIN } from "../tools/run-servers.js";
import { MCP_GROUPS } from "../workspace/server-groups.js";
import { ION_INSTRUCTIONS } from "./instructions.js";
import { serverSandbox } from "./sandbox.js";

/** Each line about a server the chat goes without, unless the chat already says it. */
function sayOnce(
  store: EventStore,
  l: { chatId: string; runId: string },
  lines: { id: string; text: string }[],
) {
  const said = store.read({ chatId: l.chatId, types: [EV.toolSkipped] }).map((e) => JSON.stringify(e.data));
  for (const data of lines)
    if (!said.includes(JSON.stringify(data)))
      store.append({ chatId: l.chatId, runId: l.runId, origin: "daemon", type: EV.toolSkipped, data });
}

/**
 * Your servers for a run's agent. One it goes without (needs a key or a sign-in, can't be reached, or the agent
 * doesn't take its kind) is said once in the chat, and never fails the run; nor does ion failing to read them.
 */
export async function yourServers(
  store: EventStore,
  servers: ((agent: RunAgent) => Promise<RunServers>) | undefined,
  l: { h: HarnessEntry; chatId: string; runId: string },
): Promise<Omit<RunServers, "skipped">> {
  if (!servers) return { specs: [], secrets: [], fresh: {}, refs: [] };
  const r = await servers({ label: l.h.label, takes: l.h.adapter.mcpTransports }).catch((e: Error) => {
    console.warn(`mcp: a run's servers couldn't be read: ${e.name}`);
    return { specs: [], skipped: [], secrets: [], fresh: {}, refs: [] };
  });
  sayOnce(store, l, r.skipped);
  return { specs: r.specs, secrets: r.secrets, fresh: r.fresh, refs: r.refs };
}

/**
 * What a run's agent is given for your servers, and what ion's gateway serves for each: every one becomes ion's own
 * URL for it (`<ion's MCP URL>/s/<name>`) with only the run's key, so no key, token, command or env of yours reaches
 * the agent. A remote one is forwarded to; a local (stdio) one ion starts itself for the run (`local`, to bridge).
 * Without ion's server (no key), yours are left out.
 */
export function throughIon(
  yours: Omit<RunServers, "skipped">,
  ion: { url: string; key: string } | null,
): {
  servers: HttpMcpSpec[];
  upstreams: Map<string, Served>;
  local: StdioSpec[];
  viaIon: string[];
  envDrop: EnvDrop;
} {
  const upstreams = new Map<string, Served>();
  const local: StdioSpec[] = [];
  const specs: HttpMcpSpec[] = [];
  for (const s of ion ? yours.specs : []) {
    if (s.transport === "stdio") local.push(s);
    else upstreams.set(s.name, upstreamOf(s, yours.fresh[s.name]));
    const url = `${ion?.url}/s/${encodeURIComponent(s.name)}`;
    specs.push({ name: s.name, transport: "http", url, headers: { Authorization: `Bearer ${ion?.key}` } });
  }
  // The agent's process inherits none of your keys: no name mcp.json uses, no value of the run's keys.
  const envDrop = { names: yours.refs, values: yours.secrets };
  const viaIon = specs.map((s) => s.name);
  return { servers: specs, upstreams, local, viaIon, envDrop };
}

/** Under ion's data folder: each run's empty folder its local servers start in (`mcp-run/<runId>`). */
export const MCP_RUN = "mcp-run";

/** What ion's gateway serves for a run, by name: a remote server it forwards to, or a local one it runs. */
export type Served = Upstream | LocalUpstream;

/** What a run is given for your servers (its agent's specs, what ion serves, the env its agent doesn't inherit). */
export type Given = Omit<ReturnType<typeof throughIon>, "local"> & { bridges: RunBridges };

/**
 * Your servers for a run, through ion: the agent gets ion's URLs; ion's gateway serves each. A local one starts on
 * the agent's first request to it, in the run's own empty folder ion owns (`mcp-run/<runId>`, never the worktree:
 * the agent could plant code there; `${ION_WORKTREE}` names the worktree); one that fails to start or stops is
 * said once in the chat, and the run goes on.
 */
export function givenToRun(
  store: EventStore,
  l: { chatId: string; runId: string; cwd: string },
  yours: Omit<RunServers, "skipped">,
  o: { ion: { url: string; key: string } | null; redact: Redact; dataDir: string; configFile?: string },
): Given {
  const { local, ...given } = throughIon(yours, o.ion);
  const bridges = bridgesFor(local, {
    folder: join(o.dataDir, MCP_RUN, l.runId),
    worktree: l.cwd,
    stopped: (name, why) => sayOnce(store, l, [{ id: name, text: `${name} ${GONE[why]}` }]),
    redact: o.redact,
    groups: join(o.dataDir, MCP_GROUPS),
    ...sandboxOf(o),
  });
  for (const s of local) given.upstreams.set(s.name, bridges.get(s.name) as LocalUpstream);
  return { ...given, bridges };
}

/** Local servers run in the OS sandbox, away from ion's folders (when ion knows its config's folder). */
const sandboxOf = (o: { dataDir: string; configFile?: string }) => {
  const sandbox = o.configFile ? serverSandbox({ dataDir: o.dataDir, configFile: o.configFile }) : undefined;
  return sandbox ? { sandbox } : {};
};

const GONE: Record<Why, string> = {
  start: "couldn't start, so this chat goes on without it.",
  crash: "stopped, so this chat goes on without it.",
  noisy: "sent too much, so ion stopped it.",
};

export type Redact = <T>(data: T) => T;

const MASK = "•••";

/**
 * Replaces each of a run's keys and tokens (8+ chars; as written, and as JSON escapes it inside a tool's input) in
 * every text of an event's data with •••. Longest first, so a token inside its "Bearer …" header goes whole.
 */
export function redactor(values: (string | undefined)[]): Redact {
  const forms = values
    .filter((v): v is string => !!v && v.length >= SECRET_MIN)
    .flatMap((v) => [v, JSON.stringify(v).slice(1, -1)]);
  const all = [...new Set(forms)].sort((a, b) => b.length - a.length);
  const text = (t: string) => all.reduce((acc, v) => (acc.includes(v) ? acc.split(v).join(MASK) : acc), t);
  const walk = (x: unknown): unknown => {
    if (typeof x === "string") return text(x);
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object")
      return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)]));
    return x;
  };
  return <T>(data: T) => (all.length ? (walk(data) as T) : data);
}

/**
 * A run's MCP servers: ion's own first (with the run's key) and its instructions, then yours; and what the agent's
 * process may not inherit (your keys).
 */
export function runMcp(
  ion: { url: string; key: string } | null,
  yours: HttpMcpSpec[] = [],
  envDrop?: EnvDrop,
): { mcpServers?: HttpMcpSpec[]; instructions?: string; envDrop?: EnvDrop } {
  const own: HttpMcpSpec[] = ion
    ? [{ name: ION_SERVER, transport: "http", url: ion.url, headers: { Authorization: `Bearer ${ion.key}` } }]
    : [];
  const all = [...own, ...yours];
  return {
    ...(all.length ? { mcpServers: all } : {}),
    ...(ion ? { instructions: ION_INSTRUCTIONS } : {}),
    ...(envDrop ? { envDrop } : {}),
  };
}
