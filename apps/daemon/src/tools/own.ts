import { mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { McpSpec } from "@ion/adapter-kit";
import type { OwnServerInfo } from "@ion/schema";
import { harnessIds } from "../adapters/registry.js";
import { type Launch, readAgentServers, readFile, standardLaunch } from "./import.js";
import { type FoundPlugin, readPlugins } from "./plugins.js";

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

type Launched = { command: string; args?: string[] } | { url: string };
const launchLine = (e: Launched) =>
  "url" in e ? launchOf({ url: e.url }) : launchOf({ command: e.command, args: e.args ?? [] });

/** Whether you turned on a repo's server, as it is now: on, never turned on (new), or changed since. */
export type RepoState = (
  project: string,
  name: string,
  v: unknown,
) => Promise<{ on: boolean; new?: true; changed?: true }>;

/** Claude Code's servers in each project's own `.mcp.json` (the repo's): each with your switch in ion. */
async function repoRows(projects: string[], state: RepoState): Promise<OwnServerInfo[]> {
  const rows = projects.flatMap((p) =>
    Object.entries(repoServers(p)).map(async ([name, v]): Promise<OwnServerInfo | null> => {
      const l = isObj(v) ? standardLaunch(v) : null;
      if (!l || l.kind === "sse" || name.toLowerCase() === "ion") return null;
      const project = basename(p);
      const repo = { project, file: ".mcp.json", id: `${project}:${name}`, ...(await state(p, name, v)) };
      const launch = l.kind === "stdio" ? launchOf(l) : launchOf({ url: l.url });
      return { agent: "claude-code", name, transport: l.kind, launch, repo };
    }),
  );
  return (await Promise.all(rows)).filter((r): r is OwnServerInfo => r !== null);
}

/**
 * Every agent's own servers (yours; a repo's own `.mcp.json` for Claude Code with your switch, off until you turn it
 * on: security review, 2026-11-21), its plugins, and each agent's switch.
 */
export async function ownToolsOf(o: {
  home: string;
  env: Env;
  projects: string[];
  agents: Record<string, boolean>;
  repo: RepoState;
}) {
  const agents = Object.fromEntries(harnessIds().map((id) => [id, o.agents[id] !== false]));
  const yours: OwnServerInfo[] = readAgentServers(o)
    .found.filter((f) => !f.repo)
    .map((f) => {
      const e = f.entry;
      return {
        agent: f.agent,
        name: f.name,
        transport: "url" in e ? "http" : "stdio",
        launch: launchLine(e),
      };
    });
  const servers = [...yours, ...(await repoRows(o.projects, o.repo))];
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

/** A project's own `.mcp.json` servers (written by the repo, not you), as written. */
export const repoServers = (project: string): Obj =>
  obj(obj(readFile(join(project, ".mcp.json"))).mcpServers);

/** What you consent to when you turn on a repo's server: which project, which server, exactly as written. */
export const repoMaterial = (project: string, name: string, v: unknown): string =>
  `repo-mcp:${JSON.stringify([project, name, v])}`;

/** Whether you turned on this repo server, as it is now. */
export type RepoOn = (name: string, v: unknown) => Promise<boolean>;

type Entry = [name: string, v: unknown, repo?: true];

/**
 * Claude Code's own servers for a chat in this project: yours, this project's entry in ~/.claude.json (both yours),
 * then the project's `.mcp.json` (the repo's: only with `repo` marked, for your consent in ion).
 */
function claudeServers(home: string, project: string): Entry[] {
  const user = obj(readFile(join(home, ".claude.json")));
  const inProject = obj(obj(user.projects)[project]);
  const disabled = new Set(Array.isArray(inProject.disabledMcpServers) ? inProject.disabledMcpServers : []);
  const all: Entry[] = [
    ...Object.entries(obj(user.mcpServers)),
    ...Object.entries(obj(inProject.mcpServers)),
    ...Object.entries(repoServers(project)).map(([n, v]): Entry => [n, v, true]),
  ];
  return all.filter(([n]) => !disabled.has(n) && n.toLowerCase() !== "ion");
}

/** A plugin's servers, `${CLAUDE_PLUGIN_ROOT}` its folder. */
const pluginServers = (p: FoundPlugin): Entry[] =>
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

/** Every value of a server as filled, for the run's redaction (security review, 2026-11-21: all of them). */
const valuesOf = (s: McpSpec): string[] =>
  s.transport === "http"
    ? [s.url, ...Object.values(s.headers)]
    : [s.command, ...s.args, ...Object.values(s.env)];

/**
 * What a Claude Code chat brings of its own: its servers (filled, each name once, the first found wins) and its
 * enabled plugins (in `dir`, ion's folder for this run, those with hooks copied without them). `secrets`: the values to
 * keep out of the run's events.
 */
export async function claudeOwnForRun(o: {
  home: string;
  /** What `${VAR}` is filled from: only what an agent may have (never ion's whole environment). */
  env: Env;
  project: string;
  dir: string;
  /** A repo's own server comes only once you turned it on in ion. */
  repoOn: RepoOn;
}) {
  const plugins = readPlugins({ home: o.home, env: o.env, projects: [o.project] }).filter(
    (p) => p.agent === "claude-code",
  );
  const seen = new Set<string>();
  const servers: McpSpec[] = [];
  const secrets: string[] = [];
  for (const [name, v, repo] of [...claudeServers(o.home, o.project), ...plugins.flatMap(pluginServers)]) {
    if (seen.has(name)) continue;
    seen.add(name);
    // A repo's server isn't even filled until you turned it on.
    if (repo && !(await o.repoOn(name, v))) continue;
    const spec = specOf(name, isObj(v) ? standardLaunch(v) : null, o.env);
    if (!spec) continue;
    servers.push(spec);
    secrets.push(...valuesOf(spec));
  }
  await rm(o.dir, { recursive: true, force: true });
  await mkdir(o.dir, { recursive: true, mode: 0o700 });
  const paths = await Promise.all(plugins.map((p, i) => withoutHooks(p, o.dir, i)));
  return { servers, plugins: paths, secrets };
}
