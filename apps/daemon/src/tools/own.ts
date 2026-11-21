import { mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpSpec } from "@ion/adapter-kit";
import type { OwnServerInfo } from "@ion/schema";
import { harnessIds } from "../adapters/registry.js";
import { type Launch, readAgentServers, readFile, standardLaunch } from "./import.js";
import { type FoundPlugin, readPlugins } from "./plugins.js";
import { argKey, urlHoldsKey } from "./secretish.js";

/**
 * Each agent's own tools (the user, 2026-11-21: agents bring their own servers, skills and plugins into ion's chats by
 * default; "Use its own tools" per agent). Codex, opencode and Grok load theirs themselves; Claude Code loads no
 * settings files under ion (its permission rules and hooks stay out), so ion reads its servers and plugins for it and
 * passes them. Only read here: an agent's own files are never written.
 */

type Obj = Record<string, unknown>;
type Env = Record<string, string | undefined>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});

/** What a server runs or where it connects, as one line (the same for the same setup, whoever has it). */
function launchOf(l: { command: string; args: string[] } | { url: string }): string {
  if ("command" in l) return [l.command, ...l.args].join(" ");
  try {
    const u = new URL(l.url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return l.url;
  }
}

/** Every agent's own servers (yours: a repo's own files are the repo's), and each agent's switch. */
export function ownToolsOf(o: {
  home: string;
  env: Env;
  projects: string[];
  agents: Record<string, boolean>;
}) {
  const agents = Object.fromEntries(harnessIds().map((id) => [id, o.agents[id] !== false]));
  const servers: OwnServerInfo[] = readAgentServers(o)
    .found.filter((f) => !f.repo)
    .map((f) => {
      const e = f.entry;
      const launch =
        "url" in e ? launchOf({ url: e.url }) : launchOf({ command: e.command, args: e.args ?? [] });
      return { agent: f.agent, name: f.name, transport: "url" in e ? "http" : "stdio", launch };
    });
  return { agents, servers, plugins: readPlugins(o).map(({ path: _p, servers: _s, ...p }) => p) };
}

// ---- Claude Code, for a run ------------------------------------------------------------------------------------

/** `${VAR}` and `${VAR:-default}` filled as Claude Code fills them; null when a variable without a default is unset. */
function fill(v: string, env: Env, missing: string[]): string {
  return v.replace(/\$\{([A-Za-z_]\w*)(?::-([^}]*))?\}/g, (_m, name: string, def?: string) => {
    const x = env[name];
    if (x !== undefined) return x;
    if (def !== undefined) return def;
    missing.push(name);
    return "";
  });
}

const fillAll = (o: Record<string, string>, env: Env, missing: string[]) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fill(v, env, missing)]));

/** One server as the run takes it, its values filled; null when it can't be (SSE, a variable that isn't set). */
function specOf(name: string, l: Launch | null, env: Env): McpSpec | null {
  if (!l || l.kind === "sse") return null;
  const missing: string[] = [];
  const spec: McpSpec =
    l.kind === "http"
      ? { name, transport: "http", url: fill(l.url, env, missing), headers: fillAll(l.headers, env, missing) }
      : {
          name,
          transport: "stdio",
          command: fill(l.command, env, missing),
          args: l.args.map((a) => fill(a, env, missing)),
          env: fillAll(l.env, env, missing),
        };
  return missing.length ? null : spec;
}

/** Whether Claude Code would load a project's `.mcp.json` server: you approved it there (Claude asks first). */
function approved(project: Obj, name: string): boolean {
  const off = Array.isArray(project.disabledMcpjsonServers) && project.disabledMcpjsonServers.includes(name);
  const on = Array.isArray(project.enabledMcpjsonServers) && project.enabledMcpjsonServers.includes(name);
  return !off && (on || project.enableAllProjectMcpServers === true);
}

/** Claude Code's own servers for a chat in this project: yours, this project's, its approved `.mcp.json` ones. */
function claudeServers(home: string, project: string): [string, unknown][] {
  const user = obj(readFile(join(home, ".claude.json")));
  const inProject = obj(obj(user.projects)[project]);
  const repo = obj(obj(readFile(join(project, ".mcp.json"))).mcpServers);
  const disabled = new Set(Array.isArray(inProject.disabledMcpServers) ? inProject.disabledMcpServers : []);
  const all: [string, unknown][] = [
    ...Object.entries(obj(user.mcpServers)),
    ...Object.entries(obj(inProject.mcpServers)),
    ...Object.entries(repo).filter(([n]) => approved(inProject, n)),
  ];
  return all.filter(([n]) => !disabled.has(n) && n.toLowerCase() !== "ion");
}

/** A plugin's servers, `${CLAUDE_PLUGIN_ROOT}` its folder. */
const pluginServers = (p: FoundPlugin): [string, unknown][] =>
  Object.entries(p.servers ?? {}).map(([n, v]) => [
    n,
    JSON.parse(JSON.stringify(v).replaceAll("${CLAUDE_PLUGIN_ROOT}", p.path ?? "")),
  ]);

const SAFE = /[^A-Za-z0-9._-]/g;

/**
 * A plugin as the run takes it: as it is, or (one that bundles hooks) ion's copy in the run's folder without them:
 * links to everything else, and its manifest without `hooks`. Hooks stay ion's (the user, 2026-11-21).
 */
async function withoutHooks(p: FoundPlugin, dir: string, n: number): Promise<string> {
  const from = p.path ?? "";
  if (!p.hooks) return from;
  const to = join(dir, `${n}-${p.name.replace(SAFE, "-")}`);
  await mkdir(join(to, ".claude-plugin"), { recursive: true, mode: 0o700 });
  for (const e of await readdir(from))
    if (e !== "hooks" && e !== ".claude-plugin") await symlink(join(from, e), join(to, e));
  const manifest = obj(readFile(join(from, ".claude-plugin", "plugin.json")));
  delete manifest.hooks;
  delete manifest.mcpServers;
  await writeFile(join(to, ".claude-plugin", "plugin.json"), JSON.stringify(manifest), { mode: 0o600 });
  return to;
}

/**
 * Every value of a server that could hold a key, for the run's redaction: header and env values, and an argument or
 * URL that was filled from a variable or looks like a key.
 */
function valuesOf(s: McpSpec, raw: Launch): string[] {
  if (s.transport === "http") {
    const url = raw.kind !== "stdio" && (raw.url !== s.url || urlHoldsKey(s.url)) ? [s.url] : [];
    return [...url, ...Object.values(s.headers)];
  }
  const args = raw.kind === "stdio" ? raw.args : [];
  const keyish = s.args.filter((a, i) => a !== args[i] || argKey(a, s.args[i - 1]));
  return [...keyish, ...Object.values(s.env)];
}

/**
 * What a Claude Code chat brings of its own: its servers (filled, each name once, the first found wins) and its
 * enabled plugins (in `dir`, ion's folder for this run, those with hooks copied without them). `secrets`: the values to
 * keep out of the run's events.
 */
export async function claudeOwnForRun(o: { home: string; env: Env; project: string; dir: string }) {
  const plugins = readPlugins({ home: o.home, env: o.env, projects: [o.project] }).filter(
    (p) => p.agent === "claude-code",
  );
  const seen = new Set<string>();
  const servers: McpSpec[] = [];
  const secrets: string[] = [];
  for (const [name, v] of [...claudeServers(o.home, o.project), ...plugins.flatMap(pluginServers)]) {
    if (seen.has(name)) continue;
    seen.add(name);
    const raw = isObj(v) ? standardLaunch(v) : null;
    const spec = specOf(name, raw, o.env);
    if (!spec || !raw) continue;
    servers.push(spec);
    secrets.push(...valuesOf(spec, raw));
  }
  await rm(o.dir, { recursive: true, force: true });
  await mkdir(o.dir, { recursive: true, mode: 0o700 });
  const paths = await Promise.all(plugins.map((p, i) => withoutHooks(p, o.dir, i)));
  return { servers, plugins: paths, secrets };
}
