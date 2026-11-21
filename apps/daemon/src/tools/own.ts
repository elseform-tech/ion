import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { McpSpec } from "@ion/adapter-kit";
import type { OwnServerInfo } from "@ion/schema";
import { harnessIds } from "../adapters/registry.js";
import { type Launch, readAgentServers, readFile, standardLaunch } from "./import.js";
import { copyWithoutHooks, needsCopy } from "./plugin-copy.js";
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

/**
 * What makes two setups of a server the same, as a short hash (no value reaches the app; task review, 2026-11-21):
 * what it runs or where it connects (no query), the names in its URL query, and its env or header names.
 */
export function matchOf(
  s:
    | { command: string; args: string[]; env: Record<string, string> }
    | { url: string; headers: Record<string, string> },
): string {
  const names = (o: Record<string, string>) => Object.keys(o).sort();
  let what: unknown[];
  if ("url" in s) {
    let query: string[] = [];
    try {
      query = [...new URL(s.url).searchParams.keys()].sort();
    } catch {
      // not a URL: matched as written
    }
    what = [launchOf({ url: s.url }), query, names(s.headers)];
  } else what = [s.command, s.args, names(s.env)];
  return createHash("sha256").update(JSON.stringify(what)).digest("hex").slice(0, 16);
}

type Launched = { command: string; args?: string[] } | { url: string };
const launchLine = (e: Launched) =>
  "url" in e ? launchOf({ url: e.url }) : launchOf({ command: e.command, args: e.args ?? [] });

/** Whether you turned on a repo's server, as it is now: on, never turned on (new), or changed since. */
export type RepoState = (
  project: string,
  name: string,
  v: unknown,
) => Promise<{ on: boolean; new?: true; changed?: true; asks?: true }>;

/** The `${NAME}`s a definition asks for (a repo's is never filled from your environment). */
export const refsIn = (v: unknown): string[] => [
  ...new Set([...JSON.stringify(v ?? null).matchAll(/\$\{([^}:]+)(?::-[^}]*)?\}/g)].map((m) => m[1]!)),
];

/** Why a repo's server is left out: a name ion can't show, or a key it would read from your environment. */
function repoProblem(p: string, name: string, v: unknown): { name: string; why: string } | null {
  const file = `${basename(p)}'s .mcp.json`;
  // Held scan, 2026-11-21: a name that breaks the rule isn't shown at all, not even cleaned.
  if (!NAME.test(name)) return { name: "a server with an unusable name", why: `${file}: ${NAME_RULE}` };
  const refs = refsIn(v);
  return refs.length ? { name, why: `${file}: asks for ${refs.join(", ")} from your environment` } : null;
}

/** A repo's server as Settings shows it: the whole URL or command as written, and the names of its headers and env. */
function repoInfo(l: Launch, name: string, repo: Record<string, unknown>): OwnServerInfo {
  const names = (o: Record<string, string>) => (Object.keys(o).length ? Object.keys(o) : undefined);
  const match = matchOf(l.kind === "stdio" ? l : { url: l.url, headers: l.headers });
  if (l.kind === "stdio") {
    const env = names(l.env);
    return {
      agent: "claude-code",
      name,
      match,
      transport: "stdio",
      launch: launchOf(l),
      repo: { ...repo, ...(env ? { env } : {}) } as OwnServerInfo["repo"],
    };
  }
  const headers = names(l.headers);
  return {
    agent: "claude-code",
    name,
    match,
    transport: "http",
    launch: l.url,
    repo: { ...repo, ...(headers ? { headers } : {}) } as OwnServerInfo["repo"],
  };
}

/**
 * Claude Code's servers in each project's own `.mcp.json` (the repo's): each with your switch (remote) or asked in each
 * chat (local); one with an unusable name, or that asks for a key from your environment, is left out with one line.
 */
async function repoRows(projects: string[], state: RepoState) {
  const leftOut: { name: string; why: string }[] = [];
  const rows = projects.flatMap((p) =>
    Object.entries(repoServers(p)).map(async ([name, v]): Promise<OwnServerInfo | null> => {
      const l = isObj(v) ? standardLaunch(v) : null;
      if (!l || l.kind === "sse" || name.toLowerCase() === "ion") return null;
      const problem = repoProblem(p, name, v);
      if (problem) leftOut.push(problem);
      if (problem) return null;
      const repo = {
        project: basename(p),
        file: ".mcp.json",
        id: repoKey(p, name),
        ...(await state(p, name, v)),
      };
      return repoInfo(l, name, repo);
    }),
  );
  const servers = (await Promise.all(rows)).filter((r): r is OwnServerInfo => r !== null);
  return { servers, leftOut };
}

/** A repo server's record and id: the project's folder and the server's name. */
export const repoKey = (project: string, name: string) => `${project}#${name}`;

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
      const match =
        "url" in e
          ? matchOf({ url: e.url, headers: e.headers ?? {} })
          : matchOf({ command: e.command, args: e.args ?? [], env: e.env ?? {} });
      return {
        agent: f.agent,
        name: f.name,
        transport: "url" in e ? "http" : "stdio",
        launch: launchLine(e),
        match,
      };
    });
  const repo = await repoRows(o.projects, o.repo);
  const plugins = readPlugins(o).map(({ path: _p, servers: _s, ...p }) => p);
  return { agents, servers: [...yours, ...repo.servers], plugins, leftOut: repo.leftOut };
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

/**
 * Whether a repo's server runs code on this computer (ruling, 2026-11-21): every local (stdio) one does, whatever it
 * says it runs; it has no lasting consent, ion asks in each chat that would start it. A remote one runs nothing here.
 */
export function runsRepoCode(v: unknown): boolean {
  const l = isObj(v) ? standardLaunch(v) : null;
  return l?.kind === "stdio";
}

/** A server's name ion shows and runs: 1-40 letters, digits, - or _. */
const NAME = /^[A-Za-z0-9_-]{1,40}$/;
const NAME_RULE = "use up to 40 letters, digits, - or _";

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
    // A repo's: only a usable name, and never one that would read your environment (task review, 2026-11-21).
    ...Object.entries(repoServers(project))
      .filter(([n, v]) => !repoProblem(project, n, v))
      .map(([n, v]): Entry => [n, v, true]),
  ];
  return all.filter(([n]) => !disabled.has(n) && n.toLowerCase() !== "ion");
}

/** Every string in a value with `${NAME}` swapped (structurally: a folder's quotes can't break the definition). */
function fillStrings(v: unknown, fills: Record<string, string>): unknown {
  if (typeof v === "string")
    return Object.entries(fills).reduce((t, [k, x]) => t.replaceAll(`\${${k}}`, () => x), v);
  if (Array.isArray(v)) return v.map((x) => fillStrings(x, fills));
  if (!isObj(v)) return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillStrings(x, fills)]));
}

const SAFE = /[^A-Za-z0-9._-]/g;

/** A plugin's servers: `${CLAUDE_PLUGIN_ROOT}` its folder, `${CLAUDE_PLUGIN_DATA}` a folder of its own in ion's data. */
const pluginServers = (p: FoundPlugin, dataRoot: string): Entry[] => {
  const fills = {
    CLAUDE_PLUGIN_ROOT: p.path ?? "",
    CLAUDE_PLUGIN_DATA: join(dataRoot, p.name.replace(SAFE, "-")),
  };
  return Object.entries(p.servers ?? {}).map(([n, v]) => [n, fillStrings(v, fills)]);
};

/**
 * A plugin as the run takes it: as it is, or ion's copy in the run's folder without hooks (its own, and any in a
 * skill's, subagent's or command's front matter; plugin-copy.ts). Hooks stay ion's (the user, 2026-11-21).
 */
async function withoutHooks(p: FoundPlugin, dir: string, n: number, lines: string[]): Promise<string> {
  const from = p.path ?? "";
  if (!needsCopy(from, !!p.hooks)) return from;
  const to = join(dir, `${n}-${p.name.replace(SAFE, "-")}`);
  await copyWithoutHooks(from, to, p.name, lines);
  return to;
}

/**
 * The values of a server to mask in a run's events (task review, 2026-11-21): env and header values always, anything
 * filled from `${VAR}` always, and its command, args or URL only when they look like a key (a path or a package name
 * stays readable).
 */
function valuesOf(s: McpSpec, raw: Launch): string[] {
  const filled = (now: string, was: string | undefined) => now !== was;
  if (s.transport === "http") {
    const was = raw.kind === "stdio" ? undefined : raw.url;
    const url = filled(s.url, was) || urlHoldsKey(s.url) ? [s.url] : [];
    return [...url, ...Object.values(s.headers)];
  }
  const r = raw.kind === "stdio" ? raw : { command: "", args: [] as string[] };
  const command = filled(s.command, r.command) || argKey(s.command, undefined) ? [s.command] : [];
  const args = s.args.filter((a, i) => filled(a, r.args[i]) || argKey(a, s.args[i - 1]));
  return [...command, ...args, ...Object.values(s.env)];
}

/** One server filled for the run, and its values to mask; null when it can't be (SSE, a variable that isn't set). */
function filled(name: string, v: unknown, env: Env): { spec: McpSpec; secrets: string[] } | null {
  const raw = isObj(v) ? standardLaunch(v) : null;
  const spec = specOf(name, raw, env);
  return spec && raw ? { spec, secrets: valuesOf(spec, raw) } : null;
}

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
  /** Where each plugin's own data folder goes (`${CLAUDE_PLUGIN_DATA}`): in ion's data folder. */
  pluginData?: string;
}) {
  const plugins = readPlugins({ home: o.home, env: o.env, projects: [o.project] }).filter(
    (p) => p.agent === "claude-code",
  );
  const seen = new Set<string>();
  const servers: McpSpec[] = [];
  const secrets: string[] = [];
  const dataRoot = o.pluginData ?? join(o.dir, "plugin-data");
  const entries = [
    ...claudeServers(o.home, o.project),
    ...plugins.flatMap((p) => pluginServers(p, dataRoot)),
  ];
  for (const [name, v, repo] of entries) {
    if (seen.has(name)) continue;
    seen.add(name);
    // A repo's server isn't even filled until you turned it on.
    const got = repo && !(await o.repoOn(name, v)) ? null : filled(name, v, o.env);
    if (!got) continue;
    servers.push(got.spec);
    secrets.push(...got.secrets);
  }
  await rm(o.dir, { recursive: true, force: true });
  await mkdir(o.dir, { recursive: true, mode: 0o700 });
  for (const p of plugins.filter((x) => Object.keys(x.servers ?? {}).length))
    await mkdir(join(dataRoot, p.name.replace(SAFE, "-")), { recursive: true, mode: 0o700 });
  const lines: string[] = [];
  const paths = await Promise.all(plugins.map((p, i) => withoutHooks(p, o.dir, i, lines)));
  return { servers, plugins: paths, secrets, lines };
}
