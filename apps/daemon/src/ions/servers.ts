import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { EnvDrop, GateCall, HttpMcpSpec, McpTransports } from "@ion/adapter-kit";
import { loadUserConfig } from "@ion/config";
import type { Judge } from "../access/index.js";
import { askServer } from "../gateway/client.js";
import { type LocalUpstream, type Upstream, upstreamOf } from "../gateway/index.js";
import type { GateAnswer } from "../gate/index.js";
import { MCP_RUN, throughIon } from "../runs/servers.js";
import { ionMayUse, type ListedTool } from "../tools/ion-use.js";
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

type Served = Upstream | LocalUpstream;

const LIST_KEPT_MS = 60_000;

/** The tools in a tools/list answer (only ones with a name). */
const toolList = (r: unknown): ListedTool[] =>
  ((r as { tools?: unknown[] } | null)?.tools ?? []).filter(
    (x): x is ListedTool => typeof (x as ListedTool | null)?.name === "string",
  );
type Turn = { upstreams: Map<string, Served>; close(): Promise<void>; tools: Map<string, Promise<ListedTool[]>> };

export type IonServersDeps = {
  configFile: string;
  dataDir: string;
  /** Your servers that are on, filled (keys and tokens stay in ion). */
  servers?: (agent: RunAgent) => Promise<RunServers>;
  /** Auto's judge, asked whether a call only reads. */
  judge?: Judge;
  /** Tests: a local server's stand-in (else ion's bridge runs it for the turn). */
  local?: (spec: StdioSpec) => LocalUpstream;
};

/**
 * Your servers for ions' turns (the user, 2026-11-21: "Read-only use"): a turn's agent gets ion's URL for each server
 * that's on, with only its turn key; ion's gateway serves them (local ones run by ion for the turn, stopped at its
 * end). Each call is allowed only when the tool is on for ions, within the limits, and the judge agrees it only reads;
 * anything else is refused with a plain line, and the ion starts a thread instead.
 */
export class IonServers {
  private readonly turns = new Map<string, Turn>();
  /** What Settings listed of each server, and when. */
  private readonly listed = new Map<string, { at: number; tools: ListedTool[] }>();

  constructor(private readonly d: IonServersDeps) {}

  /** What a turn's agent gets for your servers, and what its process may not inherit. */
  async open(
    turnId: string,
    ion: { url: string; key: string },
    takes: McpTransports,
  ): Promise<{ servers: HttpMcpSpec[]; envDrop: EnvDrop }> {
    const yours = this.d.servers
      ? await this.d.servers({ label: "ion", takes }).catch(() => null)
      : null;
    if (!yours || !yours.specs.length) return { servers: [], envDrop: { names: yours?.refs ?? [], values: [] } };
    const given = throughIon(yours, ion);
    const bridges = this.d.local
      ? null
      : bridgesFor(given.local, {
          folder: join(this.d.dataDir, MCP_RUN, turnId),
          stopped: () => {},
          groups: join(this.d.dataDir, MCP_GROUPS),
        });
    for (const s of given.local)
      given.upstreams.set(s.name, this.d.local ? this.d.local(s) : (bridges!.get(s.name) as LocalUpstream));
    this.turns.set(turnId, {
      upstreams: given.upstreams,
      tools: new Map(),
      close: async () => {
        await bridges?.close();
      },
    });
    return { servers: given.servers, envDrop: given.envDrop };
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
  async gate(turnId: string, call: GateCall, request: string): Promise<GateAnswer> {
    const server = call.mcpServer ?? "";
    const up = this.upstream(turnId, server);
    if (!up) return { decision: "deny", reason: ONLY_TOOLS };
    const limit = callLimit(call.input);
    if (limit) return { decision: "deny", reason: limit };
    // Reading a resource, getting a prompt or a completion: not a tool (the gateway names them by method).
    if (/^(resources|prompts|completion)\//.test(call.toolName)) return { decision: "deny", reason: ONLY_TOOLS };
    const tool = (await this.toolsOf(turnId, server, up)).find((t) => t.name === call.toolName);
    const entries = loadUserConfig(this.d.configFile).config.tools.ionUse;
    if (!tool || !ionMayUse(entries, server, tool)) return { decision: "deny", reason: NOT_ON };
    return this.judged(call, request);
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
    if (v.verdict === "allow" && v.decided !== false) return { decision: "allow" };
    if (v.verdict === "unsure")
      return { decision: "deny", reason: `ion isn't sure it only reads (${v.reason}), so I'll start a thread` };
    return { decision: "deny", reason: WRITES };
  }

  /**
   * A server's tools for Settings (only one that's on): started just to ask (a local one in its own folder, stopped
   * after), kept for a minute. A plain line when it can't be listed.
   */
  async listTools(name: string): Promise<ListedTool[] | string> {
    const kept = this.listed.get(name);
    if (kept && kept.at > Date.now() - LIST_KEPT_MS) return kept.tools;
    const yours = this.d.servers ? await this.d.servers({ label: "ion", takes: { http: true } }).catch(() => null) : null;
    const spec = yours?.specs.find((s) => s.name === name);
    if (!yours || !spec) return "Turn it on to see its tools";
    const bridges =
      spec.transport === "stdio" && !this.d.local
        ? bridgesFor([spec], {
            folder: join(this.d.dataDir, MCP_RUN, `list-${randomUUID()}`),
            stopped: () => {},
            groups: join(this.d.dataDir, MCP_GROUPS),
          })
        : null;
    const up: Served =
      spec.transport === "http"
        ? upstreamOf(spec, yours.fresh[name])
        : this.d.local
          ? this.d.local(spec)
          : (bridges!.get(name) as LocalUpstream);
    try {
      const tools = toolList(await askServer(up, "tools/list"));
      this.listed.set(name, { at: Date.now(), tools });
      return tools;
    } catch {
      return `ion couldn't reach ${name}`;
    } finally {
      await bridges?.close();
    }
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
