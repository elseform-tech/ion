import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parseJsonc } from "@ion/adapter-kit";
import { parse as parseToml } from "smol-toml";
import { literalKey } from "./literal.js";
import type { McpEntry } from "./mcp-file.js";

/**
 * Import (the user, 2026-11-21: "Only ion's, plus Import"): the MCP servers in each agent's own config, in mcp.json's
 * standard shape. Only read, here and now: nothing is run, contacted or written, and a key typed into an agent's config
 * is never copied (it becomes a `${NAME}` you add a key for in Settings).
 */

/** One server found in an agent's config, as mcp.json would hold it. */
export type Found = {
  agent: string;
  from: string;
  name: string;
  entry: McpEntry;
  /** The `${NAME}`s it uses. */
  keys: string[];
  /** Found in a project's own file (written by the repo, not you): which project, and the file in it. */
  repo?: Repo;
};

/** A project's own file: the project (its folder's name) and the file's path in it. */
type Repo = { project: string; file: string };

export type AgentServers = {
  found: Found[];
  problems: string[];
  skipped: { agent: string; name: string; why: string }[];
};

type ReadOpts = { home: string; env: Record<string, string | undefined>; projects: string[] };

/** A neutral launch before it's cleaned: local (a command) or remote (a URL, "sse" when it says so). */
export type Launch =
  | { kind: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { kind: "http"; url: string; headers: Record<string, string> }
  | { kind: "sse"; url: string; headers: Record<string, string> };

type Source = {
  path: string;
  servers: (raw: unknown) => Record<string, unknown> | null;
  launch: (v: Obj) => Launch | null;
  repo?: Repo;
};
type Obj = Record<string, unknown>;

const MAX = 1024 * 1024;
const NAME = /^[A-Za-z0-9_-]{1,40}$/;
const REF = /\$\{(\w+)\}/g;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === "string" ? v : "");
const texts = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const textMap = (v: unknown): Record<string, string> =>
  isObj(v)
    ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"))
    : {};

/** Claude Code's, Cursor's and Grok's shape: `command`/`args`/`env`, or `url`/`headers` (`type` "sse" when it is). */
export function standardLaunch(v: Obj): Launch | null {
  const url = text(v.url);
  if (url)
    return {
      kind: v.type === "sse" || v.transport === "sse" ? "sse" : "http",
      url,
      headers: textMap(v.headers),
    };
  const command = text(v.command);
  return command ? { kind: "stdio", command, args: texts(v.args), env: textMap(v.env) } : null;
}

/** Codex's: `http_headers`, and a key it reads from an env variable (`bearer_token_env_var`, `env_http_headers`). */
function codexLaunch(v: Obj): Launch | null {
  const url = text(v.url);
  if (!url) return standardLaunch(v);
  const headers = { ...textMap(v.http_headers) };
  for (const [h, name] of Object.entries(textMap(v.env_http_headers))) headers[h] = `\${${name}}`;
  const bearer = text(v.bearer_token_env_var);
  if (bearer) headers.Authorization = `Bearer \${${bearer}}`;
  return { kind: "http", url, headers };
}

/** opencode's `{env:NAME}` is ion's `${NAME}`. */
const opencodeRefs = (m: Record<string, string>) =>
  Object.fromEntries(Object.entries(m).map(([k, x]) => [k, x.replace(/\{env:(\w+)\}/g, "${$1}")]));

/** opencode's: `local` with `command: [cmd, ...args]` and `environment`, or `remote` with `url` and `headers`. */
function opencodeLaunch(v: Obj): Launch | null {
  if (v.type === "remote" && text(v.url))
    return { kind: "http", url: text(v.url), headers: opencodeRefs(textMap(v.headers)) };
  const [command, ...args] = texts(v.command);
  return command ? { kind: "stdio", command, args, env: opencodeRefs(textMap(v.environment)) } : null;
}

const key = (k: string) => (raw: unknown) => (isObj(raw) && isObj(raw[k]) ? raw[k] : null);

type Agent = { agent: string; from: string; sources: Source[] };

/** Claude Code: `~/.claude.json` (yours, then each of ion's projects there), then each project's `.mcp.json`. */
function claudeSources({ home, projects }: ReadOpts): Source[] {
  const path = join(home, ".claude.json");
  const inProject = (p: string) => (raw: unknown) =>
    isObj(raw) && isObj(raw.projects) ? key("mcpServers")(raw.projects[p]) : null;
  return [
    { path, servers: key("mcpServers"), launch: standardLaunch },
    ...projects.map((p) => ({ path, servers: inProject(p), launch: standardLaunch })),
    ...projects.map((p) => inRepo(p, ".mcp.json", { servers: key("mcpServers"), launch: standardLaunch })),
  ];
}

/** A file in a project, marked as the repo's (not yours). */
const inRepo = (project: string, file: string, s: Omit<Source, "path" | "repo">): Source => ({
  ...s,
  path: join(project, file),
  repo: { project: basename(project), file: relative(project, join(project, file)) },
});

const OC = { servers: key("mcp"), launch: opencodeLaunch };

/** opencode's files: yours (its config folder), then each project's (no `config.json` there). */
const opencodeSources = (o: ReadOpts, dir: string): Source[] => [
  ...["config.json", "opencode.json", "opencode.jsonc"].map((f) => ({ ...OC, path: join(dir, f) })),
  ...o.projects.flatMap((p) => ["opencode.json", "opencode.jsonc"].map((f) => inRepo(p, f, OC))),
];

/** A TOML config's `[mcp_servers]`: yours in the agent's folder, then each project's. */
const tomlSources = (o: ReadOpts, home: string, folder: string, launch: Source["launch"]): Source[] => [
  { path: join(home, "config.toml"), servers: key("mcp_servers"), launch },
  ...o.projects.map((p) => inRepo(p, join(folder, "config.toml"), { servers: key("mcp_servers"), launch })),
];

/** Every config each agent keeps its servers in, home first, then each of ion's projects. */
function sourcesOf(o: ReadOpts): Agent[] {
  const { home, env } = o;
  const opencode = join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
  return [
    { agent: "claude-code", from: "Claude Code", sources: claudeSources(o) },
    {
      agent: "codex",
      from: "Codex",
      sources: tomlSources(o, env.CODEX_HOME || join(home, ".codex"), ".codex", codexLaunch),
    },
    {
      agent: "opencode",
      from: "opencode",
      sources: opencodeSources(o, opencode),
    },
    {
      agent: "grok-build",
      from: "Grok Build",
      sources: tomlSources(o, env.GROK_HOME || join(home, ".grok"), ".grok", standardLaunch),
    },
  ];
}

/** A file's contents, parsed: undefined when it isn't there, null when it can't be read (too big, broken). */
export function readFile(path: string): unknown {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null;
  }
  try {
    // Sized and read through the same open file, so what's checked is what's read.
    if (fstatSync(fd).size > MAX) return null;
    const t = readFileSync(fd, "utf8");
    if (path.endsWith(".toml")) return parseToml(t);
    return path.endsWith(".jsonc") || path.includes("opencode") ? parseJsonc(t) : JSON.parse(t);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** A name for the key in a header: the server's, and what the header is for. */
function headerKey(server: string, header: string): string {
  const part = /^authorization$/i.test(header) ? "TOKEN" : header;
  const n = `${server}_${part}`.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return (/^\d/.test(n) ? `_${n}` : n).slice(0, 64);
}

/** Env or header values with any key typed in swapped for a `${NAME}`. */
function cleanValues(values: Record<string, string>, nameOf: (k: string) => string, kind: "env" | "headers") {
  return Object.fromEntries(
    Object.entries(values).map(([k, v]) => {
      if (!literalKey({ [kind]: { [k]: v } })) return [k, v];
      const bearer = /^\s*bearer\s+/i.test(v) ? "Bearer " : "";
      return [k, `${bearer}\${${nameOf(k)}}`];
    }),
  );
}

const envKey = (k: string) => (/^[A-Za-z_]\w{0,63}$/.test(k) && !/^ion_/i.test(k) ? k : headerKey("KEY", k));

/** The entry mcp.json would hold, or why it can't be brought in as it is. */
function entryOf(name: string, l: Launch): McpEntry | string {
  let entry: McpEntry;
  if (l.kind === "sse") return "ion connects over HTTP, not SSE";
  if (l.kind === "http") {
    const headers = cleanValues(l.headers, (h) => headerKey(name, h), "headers");
    entry = { type: "http", url: l.url, ...(Object.keys(headers).length ? { headers } : {}) };
  } else {
    const env = cleanValues(l.env, envKey, "env");
    entry = {
      command: l.command,
      ...(l.args.length ? { args: l.args } : {}),
      ...(Object.keys(env).length ? { env } : {}),
    };
  }
  if (literalKey(entry)) return "A key is in its command or url: add it with ion mcp add";
  return entry;
}

const refs = (e: McpEntry) => [...new Set([...JSON.stringify(e).matchAll(REF)].map((m) => m[1]!))];

/** `~/…` for a path in your home, so a line never shows more of it than it needs. */
const shown = (path: string, home: string) =>
  path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;

/** One server: what Import would add, why it can't come in as it is, or nothing (not a server ion can read). */
function judge(name: string, v: unknown, launch: Source["launch"]): McpEntry | string | null {
  if (!NAME.test(name)) return "Use up to 40 letters, digits, - or _";
  const l = isObj(v) ? launch(v) : null;
  return l ? entryOf(name, l) : null;
}

/** One file's servers into `out`, each name once per agent (`names`). */
function readSource(out: AgentServers, a: { agent: string; from: string }, s: Source, names: Set<string>) {
  const raw = readFile(s.path);
  if (raw === null) return false;
  for (const [name, v] of Object.entries(s.servers(raw) ?? {})) {
    if (names.has(name) || name.toLowerCase() === "ion") continue;
    names.add(name);
    const e = judge(name, v, s.launch);
    if (typeof e === "string") out.skipped.push({ agent: a.agent, name, why: e });
    else if (e)
      out.found.push({
        agent: a.agent,
        from: a.from,
        name,
        entry: e,
        keys: refs(e),
        ...(s.repo ? { repo: s.repo } : {}),
      });
  }
  return true;
}

/** Each agent's servers, in order, each once (the first place it's found wins). */
export function readAgentServers(o: ReadOpts): AgentServers {
  const out: AgentServers = { found: [], problems: [], skipped: [] };
  for (const a of sourcesOf(o)) {
    const names = new Set<string>();
    for (const s of a.sources) {
      if (readSource(out, a, s, names)) continue;
      const line = `ion couldn't read ${shown(s.path, o.home)}`;
      if (!out.problems.includes(line)) out.problems.push(line);
    }
  }
  return out;
}
