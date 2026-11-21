import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { readFile } from "./import.js";

/**
 * Each agent's own installed plugins (the user, 2026-11-21: "use the skills, mcp, or plugins that is already in the
 * harness"), as Settings → Tools → Plugins lists them. Only read, here and now: nothing is run, contacted or written.
 */

/** What a plugin brings: skills, MCP servers, commands, agents. */
type Bundles = { skills: number; servers: number; commands: number; agents: number };

/**
 * One plugin an agent loads. `hooks`: it bundles hooks, and whether they run in ion's chats ("off": ion leaves them
 * out; "run": the agent has no switch for them). `path`: its folder; `servers`: its MCP servers as written.
 */
export type FoundPlugin = {
  agent: string;
  name: string;
  version?: string;
  bundles: Bundles;
  hooks?: "off" | "run";
  /** With no version: what's in it, hashed (to match the same plugin in two agents). */
  hash?: string;
  path?: string;
  servers?: Record<string, unknown>;
};

type Obj = Record<string, unknown>;
type ReadOpts = { home: string; env: Record<string, string | undefined>; projects: string[] };

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const read = (path: string): Obj => {
  const v = readFile(path);
  return isObj(v) ? v : {};
};
const list = (dir: string): string[] => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
};

/** A plugin's manifest, in whichever agent's folder it keeps it. */
const manifestOf = (dir: string): Obj =>
  [".claude-plugin", ".codex-plugin", ".grok-plugin", ""]
    .map((m) => join(dir, m, "plugin.json"))
    .map((f) => (existsSync(f) ? read(f) : null))
    .find((m) => m !== null) ?? {};

/** Its MCP servers: the manifest's own, else `.mcp.json` (its `mcpServers`, or the file itself). */
function serversOf(dir: string, manifest: Obj): Obj {
  if (isObj(manifest.mcpServers)) return manifest.mcpServers;
  const file = read(join(dir, text(manifest.mcpServers) ?? ".mcp.json"));
  return isObj(file.mcpServers) ? file.mcpServers : file;
}

/** What's in a plugin with no version: its manifest and the text of its skills, commands and agents, hashed. */
function contentHash(dir: string, manifest: Obj): string {
  const h = createHash("sha256").update(JSON.stringify(manifest));
  for (const sub of ["skills", "commands", "agents"])
    for (const e of list(join(dir, sub))) {
      const f = sub === "skills" ? join(dir, sub, e, "SKILL.md") : join(dir, sub, e);
      h.update(`${sub}/${e}\0`);
      try {
        h.update(readFileSync(f));
      } catch {
        // a folder, or not readable: its name counts
      }
    }
  return h.digest("hex").slice(0, 12);
}

/** A plugin in its folder: what it bundles, and whether it has hooks. */
function inFolder(agent: string, dir: string, hooks: "off" | "run", fallback: Obj = {}): FoundPlugin {
  const m = { ...fallback, ...manifestOf(dir) };
  const servers = serversOf(dir, m);
  const md = (sub: string) => list(join(dir, sub)).filter((f) => f.endsWith(".md")).length;
  const bundles = {
    skills: list(join(dir, "skills")).filter((s) => existsSync(join(dir, "skills", s, "SKILL.md"))).length,
    servers: Object.keys(servers).length,
    commands: md("commands"),
    agents: md("agents"),
  };
  const hasHooks = m.hooks !== undefined || existsSync(join(dir, "hooks", "hooks.json"));
  const version = text(m.version);
  const hash = version ? undefined : contentHash(dir, m);
  return {
    agent,
    name: text(m.name) ?? basename(dir),
    ...(version ? { version } : {}),
    bundles,
    ...(hasHooks ? { hooks } : {}),
    ...(hash ? { hash } : {}),
    path: dir,
    servers,
  };
}

/** Claude Code's: installed (`installed_plugins.json`: yours, or this project's) and turned on in its settings. */
function claudePlugins(o: ReadOpts): FoundPlugin[] {
  const root = join(o.home, ".claude");
  const installed = read(join(root, "plugins", "installed_plugins.json")).plugins;
  const enabled = read(join(root, "settings.json")).enabledPlugins;
  if (!isObj(installed) || !isObj(enabled)) return [];
  return Object.entries(installed).flatMap(([id, entries]) => {
    if (enabled[id] !== true || !Array.isArray(entries)) return [];
    const mine = entries
      .filter(isObj)
      .find((e) => e.scope === "user" || o.projects.includes(String(e.projectPath)));
    const path = text(mine?.installPath);
    if (!path || !existsSync(path)) return [];
    // ion's copy of a plugin leaves its hooks out (own-claude.ts).
    return [inFolder("claude-code", path, "off", { name: id.split("@")[0], version: mine?.version })];
  });
}

/** Codex's: turned on in its config.toml (`[plugins."name@marketplace"]`), its newest copy in its plugin cache. */
function codexPlugins(o: ReadOpts): FoundPlugin[] {
  const home = o.env.CODEX_HOME || join(o.home, ".codex");
  const table = read(join(home, "config.toml")).plugins;
  if (!isObj(table)) return [];
  return Object.entries(table).flatMap(([id, v]) => {
    if (!isObj(v) || v.enabled !== true) return [];
    const [name = id, market = ""] = id.split("@");
    const dir = join(home, "plugins", "cache", market, name);
    const version = list(dir).at(-1);
    // Codex's hooks, a plugin's too, are turned off in ion's chats (the Codex adapter's gate).
    return version ? [inFolder("codex", join(dir, version), "off", { name })] : [];
  });
}

/** Grok's: each folder in its installed-plugins (Grok has no switch for their hooks). */
function grokPlugins(o: ReadOpts): FoundPlugin[] {
  const dir = join(o.env.GROK_HOME || join(o.home, ".grok"), "installed-plugins");
  return list(dir)
    .filter((d) => existsSync(join(dir, d, ".grok-plugin", "plugin.json")))
    .map((d) => inFolder("grok-build", join(dir, d), "run"));
}

const NONE: Bundles = { skills: 0, servers: 0, commands: 0, agents: 0 };

/** An npm plugin as opencode lists it ("name@1.2.0", "@scope/name"), or a file. */
function opencodeEntry(entry: string): FoundPlugin {
  const file = /^file:\/\//.test(entry);
  const at = entry.lastIndexOf("@");
  const named = !file && at > 0;
  let name = named ? entry.slice(0, at) : entry;
  if (file) name = basename(entry).replace(/\.[^.]+$/, "");
  return {
    agent: "opencode",
    name,
    ...(named ? { version: entry.slice(at + 1) } : {}),
    bundles: NONE,
    hooks: "run",
  };
}

/** opencode's: its config's `plugin` list and its folder's plugin files; every one is hook code, which runs too. */
function opencodePlugins(o: ReadOpts): FoundPlugin[] {
  const dir = join(o.env.XDG_CONFIG_HOME || join(o.home, ".config"), "opencode");
  const listed = ["config.json", "opencode.json", "opencode.jsonc"].flatMap((f) => {
    const p = read(join(dir, f)).plugin;
    return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
  });
  const files = ["plugin", "plugins"].flatMap((sub) =>
    list(join(dir, sub))
      .filter((f) => /\.(js|ts|mjs)$/.test(f))
      .map((f) => `file://${join(dir, sub, f)}`),
  );
  return [...new Set([...listed, ...files])].map(opencodeEntry);
}

/** Every agent's plugins, in the order Settings shows the agents. */
export function readPlugins(o: ReadOpts): FoundPlugin[] {
  return [...claudePlugins(o), ...codexPlugins(o), ...grokPlugins(o), ...opencodePlugins(o)];
}
