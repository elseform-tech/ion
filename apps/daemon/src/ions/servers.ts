import { join } from "node:path";
import type { EnvDrop, GateCall, HttpMcpSpec, McpTransports, RunSandbox } from "@ion/adapter-kit";
import { loadUserConfig, saveUserConfig } from "@ion/config";
import type { Judge } from "../access/index.js";
import { askServer } from "../gateway/client.js";
import type { LocalUpstream, Upstream } from "../gateway/index.js";
import type { GateAnswer } from "../gate/index.js";
import { MCP_RUN, throughIon } from "../runs/servers.js";
import { serverSandbox } from "../runs/sandbox.js";
import { ionMayUse, ionUseOf, type ListedTool } from "../tools/ion-use.js";
import { type ListedResource, ServerAsks, toolList } from "../tools/server-asks.js";
import type { RunAgent, RunServers } from "../tools/run-servers.js";
import { bridgesFor, type StdioSpec } from "../workspace/mcp-bridge.js";
import { MCP_GROUPS } from "../workspace/server-groups.js";

/** Limits on an ion's call to your servers, the same as its web searches (the user, 2026-11-21). */
const TEXT_MAX = 200;
const INPUT_MAX = 2048;
/** A run of 40+ base64 or hex characters: an encoded blob. */
const BLOB = /[A-Za-z0-9+/=_-]{40,}/;

const TOO_LONG = "That's too long for an ion's call, so I'll start a thread";
const ENCODED = "That looks like encoded data, so I'll start a thread";
const NOT_ON = "That tool isn't on for ions, so I'll start a thread";
const WRITES = "That changes something, so I'll start a thread";
const ONLY_TOOLS = "An ion only calls a server's tools, so I'll start a thread";

/** Every text in a call's input (keys too). */
function texts(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(texts);
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => [k, ...texts(x)]);
  return [];
}

/** Why an ion's call input is refused (each text ≤ 200 characters, no encoded blob, the whole ≤ 2 KB), or null. */
export function callLimit(input: Record<string, unknown>): string | null {
  if (Buffer.byteLength(JSON.stringify(input)) > INPUT_MAX) return TOO_LONG;
  const all = texts(input);
  if (all.some((t) => t.length > TEXT_MAX)) return TOO_LONG;
  return all.some((t) => BLOB.test(t)) ? ENCODED : null;
}

/** Why an ion's call is refused before its tool is looked at: not a tool, or past the limits; null: go on. */
function refusalOf(call: GateCall): string | null {
  // Reading a resource, getting a prompt or a completion: not a tool (the gateway names them by method).
  if (/^(resources|prompts|completion)\//.test(call.toolName)) return ONLY_TOOLS;
  return callLimit(call.input);
}

type Served = Upstream | LocalUpstream;

/** Your servers less any named like one of the agent's own (it would reach its own by that name, past ion). */
function withoutOwn(yours: RunServers, own: string[]): RunServers {
  const lower = new Set(own.map((n) => n.toLowerCase()));
  const left = yours.specs.filter((s) => lower.has(s.name.toLowerCase()));
  for (const s of left)
    console.warn(`ion: ions go without ${s.name}: the agent has a server of its own by that name`);
  return { ...yours, specs: yours.specs.filter((s) => !lower.has(s.name.toLowerCase())) };
}
/** A call an ion's agent makes on one of your servers, as ion's gateway reads it. */
export type IonGateCall = GateCall;

type Turn = {
  upstreams: Map<string, Served>;
  /** The agent's own servers' names: a call to one is never let on (task review, 2026-11-21). */
  own: string[];
  close(): Promise<void>;
  tools: Map<string, Promise<ListedTool[]>>;
};

export type IonServersDeps = {
  configFile: string;
  dataDir: string;
  /** Your servers that are on, filled (keys and tokens stay in ion). */
  servers?: (agent: RunAgent) => Promise<RunServers>;
  /** Auto's judge, asked whether a call only reads. */
  judge?: Judge;
  /** Tests: a local server's stand-in (else ion's bridge runs it for the turn). */
  local?: (spec: StdioSpec) => LocalUpstream;
  /** Told each time the judge is unsure of an ion's call (it counts toward "Auto often isn't sure about"). */
  onUnsure?: (call: GateCall) => void;
  /** An agent's own servers' names (it loads them itself, e.g. Grok's config.toml): ions never reach these names. */
  ownNames?: (agent: string) => Promise<string[]>;
};

/**
 * Your servers for ions' turns (the user, 2026-11-21: "Read-only use"): a turn's agent gets ion's URL for each server
 * that's on, with only its turn key; ion's gateway serves them (local ones run by ion for the turn, stopped at its
 * end). Each call is allowed only when the tool is on for ions, within the limits, and the judge agrees it only reads;
 * anything else is refused with a plain line, and the ion starts a thread instead.
 */
export class IonServers {
  private readonly turns = new Map<string, Turn>();
  /** Ion's own questions to your servers (their tools, their resources). */
  private readonly asks: ServerAsks;
  /** The OS sandbox ion's local servers run in, away from ion's folders. */
  private readonly sandbox: RunSandbox | undefined;

  constructor(private readonly d: IonServersDeps) {
    this.asks = new ServerAsks(d);
    this.sandbox = serverSandbox(d);
  }

  /** What a turn's agent gets for your servers, and what its process may not inherit. */
  async open(
    turnId: string,
    ion: { url: string; key: string },
    takes: McpTransports,
    own: string[] = [],
  ): Promise<{ servers: HttpMcpSpec[]; envDrop: EnvDrop }> {
    const all = this.d.servers ? await this.d.servers({ label: "ion", takes }).catch(() => null) : null;
    const yours = all && withoutOwn(all, own);
    this.turns.set(turnId, { upstreams: new Map(), own, tools: new Map(), close: async () => {} });
    if (!yours || !yours.specs.length)
      return { servers: [], envDrop: { names: yours?.refs ?? [], values: [] } };
    const given = throughIon(yours, ion);
    const bridges = this.d.local
      ? null
      : bridgesFor(given.local, {
          folder: join(this.d.dataDir, MCP_RUN, turnId),
          stopped: () => {},
          groups: join(this.d.dataDir, MCP_GROUPS),
          ...(this.sandbox ? { sandbox: this.sandbox } : {}),
        });
    for (const s of given.local)
      given.upstreams.set(s.name, this.d.local ? this.d.local(s) : (bridges!.get(s.name) as LocalUpstream));
    this.turns.set(turnId, {
      upstreams: given.upstreams,
      own,
      tools: new Map(),
      close: async () => {
        await bridges?.close();
      },
    });
    return { servers: given.servers, envDrop: given.envDrop };
  }

  /**
   * Your servers for a turn's agent (ion's URL for each, the turn's key); none for a report's turn (no words of yours
   * to judge by) or when ion can't give them.
   */
  async forTurn(
    turnId: string,
    ion: { url: string; key: string },
    adapter: { id: string; mcpTransports: McpTransports },
    report: boolean,
  ): Promise<HttpMcpSpec[]> {
    if (report) return [];
    const own = (await this.d.ownNames?.(adapter.id).catch(() => [])) ?? [];
    return (await this.open(turnId, ion, adapter.mcpTransports, own).catch(() => null))?.servers ?? [];
  }

  /** A turn's servers through ion's gateway, and the agent's own names its hook never lets a call to. */
  of(turnId: string): { served: string[]; own: string[] } {
    return { served: this.names(turnId), own: this.own(turnId) };
  }

  /** The agent's own servers' names in a turn (its hook never lets a call to one on). */
  own(turnId: string): string[] {
    return this.turns.get(turnId)?.own ?? [];
  }

  /** The names of a turn's servers (its agent's own hook lets their calls through: the gateway decides them). */
  names(turnId: string): string[] {
    return [...(this.turns.get(turnId)?.upstreams.keys() ?? [])];
  }

  upstream(turnId: string, name: string): Served | null {
    return this.turns.get(turnId)?.upstreams.get(name) ?? null;
  }

  async close(turnId: string): Promise<void> {
    const t = this.turns.get(turnId);
    this.turns.delete(turnId);
    await t?.close().catch(() => {});
  }

  /** ion's gate for an ion's call on one of your servers: `request`, your words in this turn. */
  async gate(turnId: string, call: GateCall, request: string | null | undefined): Promise<GateAnswer> {
    if (request === undefined) return { decision: "deny", reason: "That turn is over" };
    // A report's turn has no words of yours to judge by: it reads nothing of your servers.
    if (request === null) return { decision: "deny", reason: "Not in a report" };
    const server = call.mcpServer ?? "";
    const up = this.upstream(turnId, server);
    const refused = up ? refusalOf(call) : ONLY_TOOLS;
    if (refused || !up) return { decision: "deny", reason: refused ?? ONLY_TOOLS };
    const tool = (await this.toolsOf(turnId, server, up)).find((t) => t.name === call.toolName);
    const entries = loadUserConfig(this.d.configFile).config.tools.ionUse;
    if (tool) this.firstLook(entries, server, tool);
    if (!tool || !ionMayUse(entries, server, tool)) return { decision: "deny", reason: NOT_ON };
    return this.judged(call, request);
  }

  /** A tool ion sees for the first time is kept as its server labels it, so a later change turns it off for ions. */
  private firstLook(entries: string[], server: string, tool: ListedTool): void {
    const { seen } = ionUseOf(entries, server, [tool]);
    if (seen.length === entries.length) return;
    const file = this.d.configFile;
    const { config, error } = loadUserConfig(file);
    if (error) return;
    const ionUse = ionUseOf(config.tools.ionUse, server, [tool]).seen;
    saveUserConfig(file, { ...config, tools: { ...config.tools, ionUse } });
  }

  /** The judge's word on whether the call only reads: yes allows; no or unsure starts a thread. */
  private async judged(call: GateCall, request: string): Promise<GateAnswer> {
    if (!this.d.judge) return { decision: "deny", reason: WRITES };
    const v = await this.d.judge({
      projectId: "ion",
      text: request,
      req: { requestId: "ion", toolId: "ion", ...call },
      onlyReads: true,
    });
    if (v.decided === false)
      return { decision: "deny", reason: "ion couldn't decide, so I'll start a thread" };
    if (v.verdict === "allow") return { decision: "allow" };
    if (v.verdict === "unsure") this.d.onUnsure?.(call);
    if (v.verdict === "unsure")
      return {
        decision: "deny",
        reason: `ion isn't sure it only reads (${v.reason}), so I'll start a thread`,
      };
    return { decision: "deny", reason: WRITES };
  }

  /** A server's tools for Settings (only one that's on), or a plain line why they can't be listed. */
  listTools(name: string): Promise<ListedTool[] | string> {
    return this.asks.tools(name);
  }

  /** A server's resources for "@" (servers ion runs). */
  listResources(name: string): Promise<ListedResource[]> {
    return this.asks.resources(name);
  }

  /** A server's tools as it lists them now (once per turn). */
  private toolsOf(turnId: string, server: string, up: Served): Promise<ListedTool[]> {
    const t = this.turns.get(turnId)!;
    let p = t.tools.get(server);
    if (!p) {
      p = askServer(up, "tools/list")
        .then(toolList)
        .catch(() => []);
      t.tools.set(server, p);
    }
    return p;
  }
}
