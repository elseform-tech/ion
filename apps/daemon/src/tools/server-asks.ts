import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { stripControl } from "@ion/schema";
import { askServer } from "../gateway/client.js";
import { type LocalUpstream, type Upstream, upstreamOf } from "../gateway/index.js";
import { MCP_RUN } from "../runs/servers.js";
import { serverSandbox } from "../runs/sandbox.js";
import { bridgesFor, type StdioSpec } from "../workspace/mcp-bridge.js";
import { MCP_GROUPS } from "../workspace/server-groups.js";
import type { ListedTool } from "./ion-use.js";
import type { RunAgent, RunServers } from "./run-servers.js";

const KEPT_MS = 60_000;
const MAX_RESOURCES = 50;

type Served = Upstream | LocalUpstream;
/** A resource "@" lists: its name (cleaned) and URI. */
export type ListedResource = { name: string; uri: string };

/** The tools in a tools/list answer (only ones with a name). */
export const toolList = (r: unknown): ListedTool[] =>
  ((r as { tools?: unknown[] } | null)?.tools ?? []).filter(
    (x): x is ListedTool => typeof (x as ListedTool | null)?.name === "string",
  );

/** The resources in a resources/list answer: at most 50, names and URIs on one line, control characters gone. */
const resourceList = (r: unknown): ListedResource[] =>
  ((r as { resources?: unknown[] } | null)?.resources ?? [])
    .flatMap((x) => {
      const { uri, name } = (x ?? {}) as { uri?: unknown; name?: unknown };
      if (typeof uri !== "string" || !uri || uri.length > 500 || /\s/.test(uri)) return [];
      const shown = stripControl(typeof name === "string" && name ? name : uri)
        .replace(/\s+/g, " ")
        .slice(0, 80);
      return [{ name: shown, uri: stripControl(uri) }];
    })
    .slice(0, MAX_RESOURCES);

/** A local server asked by ion runs in the OS sandbox too (when ion knows its config's folder). */
const sandboxFor = (d: { dataDir: string; configFile?: string }) => {
  const sandbox = d.configFile ? serverSandbox({ dataDir: d.dataDir, configFile: d.configFile }) : undefined;
  return sandbox ? { sandbox } : {};
};

/**
 * Ion's own questions to one of your servers that's on (its tools for "Ions can use", its resources for "@"): started
 * just to ask (a local one in its own empty folder, stopped after), kept for a minute.
 */
export class ServerAsks {
  private readonly kept = new Map<string, { at: number; v: unknown }>();

  constructor(
    private readonly d: {
      dataDir: string;
      configFile?: string;
      servers?: (agent: RunAgent) => Promise<RunServers>;
      local?: (spec: StdioSpec) => LocalUpstream;
    },
  ) {}

  /** A server's tools, or a plain line why they can't be listed. */
  async tools(name: string): Promise<ListedTool[] | string> {
    const r = await this.ask(name, "tools/list");
    return typeof r === "string" ? r : toolList(r);
  }

  /** A server's resources (none when it has none or can't be reached). */
  async resources(name: string): Promise<ListedResource[]> {
    const r = await this.ask(name, "resources/list");
    return typeof r === "string" ? [] : resourceList(r);
  }

  private async ask(name: string, method: string): Promise<unknown> {
    const key = `${name}\n${method}`;
    const kept = this.kept.get(key);
    if (kept && kept.at > Date.now() - KEPT_MS) return kept.v;
    const yours = this.d.servers
      ? await this.d.servers({ label: "ion", takes: { http: true } }).catch(() => null)
      : null;
    const spec = yours?.specs.find((s) => s.name === name);
    if (!yours || !spec) {
      // Task 11, 2026-11-22: on but left out (not signed in, no key) says why.
      const skipped = yours?.skipped.find((x) => x.id === name)?.text;
      return skipped
        ? skipped.replace(/, so this chat runs without it\.$/, "")
        : "Turn it on to see its tools";
    }
    const { up, bridges } = this.reach(spec, yours.fresh[name]);
    try {
      const v = await askServer(up, method);
      this.kept.set(key, { at: Date.now(), v });
      return v;
    } catch {
      return `ion couldn't reach ${name}`;
    } finally {
      await bridges?.close();
    }
  }

  /** One server, reached just to ask it (a local one in its own folder, closed by the caller). */
  private reach(spec: RunServers["specs"][number], fresh?: () => Promise<string | null>) {
    if (spec.transport === "http") return { up: upstreamOf(spec, fresh) as Served, bridges: null };
    if (this.d.local) return { up: this.d.local(spec) as Served, bridges: null };
    const bridges = bridgesFor([spec], {
      folder: join(this.d.dataDir, MCP_RUN, `list-${randomUUID()}`),
      stopped: () => {},
      groups: join(this.d.dataDir, MCP_GROUPS),
      ...sandboxFor(this.d),
    });
    return { up: bridges.get(spec.name) as Served, bridges };
  }
}
