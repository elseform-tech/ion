import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseJsonc } from "@ion/adapter-kit";

/**
 * opencode's own config, carried into a file of ion's. With "Use its own tools" on (the user, 2026-11-21: agents bring
 * their own), your servers (`mcp`), plugins (the `plugin` list and your config folder's plugin files), agents, commands
 * and instructions come along, ion's gate plugin first; opencode plugins are hook code, so theirs run too (Settings
 * says so). Off: only ion's tools (the user, 2026-11-21: "Only ion's, plus Import"). opencode loads servers and
 * plugins from its own config folder (`$XDG_CONFIG_HOME/opencode`: opencode.json(c), config.json, plugin/), from
 * `~/.opencode`, and from OPENCODE_CONFIG / OPENCODE_CONFIG_DIR. Its `--pure` drops every plugin, ion's gate too, and
 * an inline config can't take servers or plugins away (it merges; plugins add up), checked on opencode 1.18.8. So
 * ion points XDG_CONFIG_HOME at an empty folder of its own, carries what your config says besides servers and plugins
 * inline, and turns `~/.opencode`'s servers off by name. Your own files are only read, never changed.
 */

const MAX = 1024 * 1024;
const FILES = ["config.json", "opencode.json", "opencode.jsonc"];

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** One config file as an object: missing, too big or unreadable is nothing. */
function readConfig(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path) || statSync(path).size > MAX) return {};
    const v = parseJsonc(readFileSync(path, "utf8"));
    return isObject(v) ? v : {};
  } catch {
    return {};
  }
}

/** Your config folder for opencode, as opencode finds it. */
export const userConfigHome = (): string => process.env.XDG_CONFIG_HOME || join(homedir(), ".config");

/** Without its servers, plugins and skill folders. */
function withoutTools(c: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...c };
  delete rest.mcp;
  delete rest.plugin;
  delete rest.skills;
  return rest;
}

/**
 * The skill folders opencode reads with your own tools (task review, 2026-11-21): its own (your config folder's, which
 * moving XDG_CONFIG_HOME would drop) and the home ones it reads from Claude Code and the shared folder, then any your
 * config names; external skills are off (OPENCODE_DISABLE_EXTERNAL_SKILLS), so a project's never come by themselves.
 */
export function ownSkillPaths(base: Record<string, unknown>): string[] {
  const yours = isObject(base.skills) && Array.isArray(base.skills.paths) ? base.skills.paths : [];
  const home = [
    join(userConfigHome(), "opencode", "skills"),
    join(homedir(), ".claude", "skills"),
    join(homedir(), ".agents", "skills"),
  ];
  return [...new Set([...home, ...yours.filter((p): p is string => typeof p === "string")])];
}

/** Shallow merge, one level into objects (what opencode merges deeply, enough for its top-level sections). */
function merge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObject(out[k]) && isObject(v) ? { ...out[k], ...v } : v;
  return out;
}

/** A path in your config that's relative (not absolute, not `~/…`, not a link): made whole against your folder. */
const relative = (p: string) => !isAbsolute(p) && !p.startsWith("~") && !/^[a-z]+:\/\//i.test(p);

/** `{file:./x}` anywhere in a value, made whole against `dir` (opencode reads it relative to the config file). */
function wholeFiles(v: unknown, dir: string): unknown {
  if (typeof v === "string")
    return v.replace(/\{file:([^}]+)\}/g, (m, f: string) => (relative(f) ? `{file:${join(dir, f)}}` : m));
  if (Array.isArray(v)) return v.map((x) => wholeFiles(x, dir));
  if (!isObject(v)) return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, wholeFiles(x, dir)]));
}

/** A plugin entry: an npm name as written; a relative path made a whole file URL against your folder. */
const pluginEntry = (x: string, dir: string) => (/^\.{1,2}\//.test(x) ? pathToFileURL(join(dir, x)).href : x);

/** Your config file as ion carries it (servers and plugins only with your own tools), paths made whole. */
function carried(c: Record<string, unknown>, dir: string, own: boolean): Record<string, unknown> {
  const out = wholeFiles(own ? c : withoutTools(c), dir) as Record<string, unknown>;
  if (Array.isArray(out.instructions))
    out.instructions = out.instructions.map((x) => (typeof x === "string" && relative(x) ? join(dir, x) : x));
  if (Array.isArray(out.plugin))
    out.plugin = out.plugin.filter((x) => typeof x === "string").map((x) => pluginEntry(x, dir));
  return out;
}

/** Plugin lists add up across opencode's config files (each once); other sections merge. */
function mergeOwn(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out = merge(a, b);
  const plugins = [a.plugin, b.plugin].flatMap((p) => (Array.isArray(p) ? p : []));
  if (plugins.length) out.plugin = [...new Set(plugins)];
  return out;
}

/** The plugin files in your config folder (`plugin/` and `plugins/`, .js and .ts), which opencode loads by itself. */
function folderPlugins(dir: string): string[] {
  return ["plugin", "plugins"].flatMap((sub) => {
    try {
      return readdirSync(join(dir, sub))
        .filter((f) => /\.(js|ts|mjs)$/.test(f))
        .sort()
        .map((f) => pathToFileURL(join(dir, sub, f)).href);
    } catch {
      return [];
    }
  });
}

/**
 * The base of the config ion writes for opencode: what your opencode config says (your folder's files, then an inline
 * config in ion's environment). Without your own tools, servers and plugins are left out and `~/.opencode`'s servers
 * (which still load) are each turned off.
 */
export function carriedConfig(own = false): Record<string, unknown> {
  const dir = join(userConfigHome(), "opencode");
  let base: Record<string, unknown> = {};
  for (const f of FILES) base = mergeOwn(base, carried(readConfig(join(dir, f)), dir, own));
  let inline: unknown = null;
  try {
    inline = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}");
  } catch {
    // ignore an unreadable inline config; ion's permissions still apply
  }
  if (isObject(inline)) base = mergeOwn(base, own ? inline : withoutTools(inline));
  return own ? withFolderPlugins(base, dir) : withLegacyOff(base);
}

/** Your config folder's plugin files after the plugins your config lists. */
function withFolderPlugins(base: Record<string, unknown>, dir: string): Record<string, unknown> {
  const plugins = [...(Array.isArray(base.plugin) ? base.plugin : []), ...folderPlugins(dir)];
  return { ...base, ...(plugins.length ? { plugin: [...new Set(plugins)] } : {}) };
}

/** `~/.opencode`'s servers (which still load) each turned off. */
function withLegacyOff(base: Record<string, unknown>): Record<string, unknown> {
  const legacy = FILES.map((f) => readConfig(join(homedir(), ".opencode", f)).mcp).filter(isObject);
  const names = [...new Set(legacy.flatMap((m) => Object.keys(m)))];
  return names.length
    ? { ...base, mcp: Object.fromEntries(names.map((n) => [n, { enabled: false }])) }
    : base;
}

/** ion's own folder in your cache folder (`$XDG_CACHE_HOME/ion`, else `~/.cache/ion`). */
const ionCache = (): string => join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "ion");

/**
 * ion's config folder for opencode: one per ion home (`<cache>/ion/opencode/<short hash of ION_HOME>`, `default`
 * without one), so what opencode installs there for its plugin package, once, is kept. Live, 2026-11-21: a fresh
 * folder made a chat's start wait on that install and time out; one per ion data folder made every test's daemon
 * install it again. Final review, 2026-11-21: one per computer let the tour, a dev daemon and the app rewrite it
 * under each other. It's inside one of ion's own folders: no run can write there.
 */
export const ionConfigHome = (own = false): string => {
  const home = process.env.ION_HOME;
  const key = home ? createHash("sha256").update(resolve(home)).digest("hex").slice(0, 12) : "default";
  // With your own tools, a folder of its own: chats and ion's judge (ion's tools only) start opencode at the same
  // time, and one file for both would be rewritten under the other's start.
  return join(ionCache(), "opencode", own ? `${key}-own` : key);
};

const UNSAFE = "ion's folder for opencode isn't safe";
/** What opencode itself keeps in its config folder for ion's plugin; everything else is removed at each start. */
const KEEP = new Set([
  "opencode.json",
  "package.json",
  "package-lock.json",
  "bun.lock",
  "node_modules",
  ".gitignore",
]);
const PLUGIN_PACKAGE = "@opencode-ai/plugin";
/**
 * What opencode writes as its config folder's .gitignore when it's missing (opencode 1.18.8, byte for byte): written
 * by ion, so opencode needn't write there in a run's sandbox (live, 2026-11-21: it stopped at its start).
 */
const GITIGNORE = "node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore";

/** A folder of ion's: made (only you), else checked: yours, only you, not a link. */
function ownFolder(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { mode: 0o700 });
  const st = lstatSync(p);
  const mine = process.getuid ? st.uid === process.getuid() : true;
  if (st.isSymbolicLink() || !st.isDirectory() || !mine || (st.mode & 0o077) !== 0)
    throw new Error(`${UNSAFE}: ${p}`);
}

/** Writes a file whole, only you can read it, swapped in at once; nothing when it already says this. */
function writeWhole(path: string, text: string): void {
  try {
    if (readFileSync(path, "utf8") === text && (lstatSync(path).mode & 0o077) === 0) return;
  } catch {
    // not there yet
  }
  const tmp = join(dirname(path), `.ion.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
  renameSync(tmp, path);
}

/** package.json with only opencode's own plugin package (what it installs there itself). */
function onlyPluginPackage(path: string): void {
  if (!existsSync(path)) return;
  let deps: unknown;
  try {
    deps = (JSON.parse(readFileSync(path, "utf8")) as { dependencies?: unknown }).dependencies;
  } catch {
    rmSync(path, { force: true });
    return;
  }
  const version = isObject(deps) ? deps[PLUGIN_PACKAGE] : undefined;
  const kept = typeof version === "string" ? { [PLUGIN_PACKAGE]: version } : {};
  writeWhole(path, `${JSON.stringify({ dependencies: kept }, null, 2)}\n`);
}

/**
 * Puts ion's folder for opencode back to exactly what ion wants (task review, 2026-11-21: a plugin, tool, config file
 * or dependency left there would load in every later chat): its config, and only what opencode keeps for its plugin
 * package. A folder that isn't ion's own is refused plainly. Returns the folder (opencode's XDG_CONFIG_HOME).
 */
export function writeIonConfig(config: Record<string, unknown>, own = false): string {
  const home = ionConfigHome(own);
  const cache = ionCache();
  mkdirSync(dirname(cache), { recursive: true, mode: 0o700 });
  for (const p of [cache, dirname(home), home, join(home, "opencode")]) ownFolder(p);
  const dir = join(home, "opencode");
  for (const name of readdirSync(dir))
    if (!KEEP.has(name)) rmSync(join(dir, name), { recursive: true, force: true });
  onlyPluginPackage(join(dir, "package.json"));
  if (own) takePluginPackage(dir, join(ionConfigHome(false), "opencode"));
  writeWhole(join(dir, ".gitignore"), GITIGNORE);
  writeWhole(join(dir, "opencode.json"), `${JSON.stringify(config, null, 2)}\n`);
  return home;
}

const installed = (dir: string) => existsSync(join(dir, "node_modules", PLUGIN_PACKAGE));

/**
 * opencode's plugin package, copied from ion's other folder when it's installed there and not here yet, so the first
 * chat with your own tools doesn't wait on the install (live, 2026-11-21: that wait timed a first chat out).
 */
function takePluginPackage(dir: string, from: string): void {
  if (installed(dir) || !installed(from) || lstatSync(from).isSymbolicLink()) return;
  try {
    cpSync(join(from, "node_modules"), join(dir, "node_modules"), { recursive: true });
    for (const f of ["package.json", "package-lock.json", "bun.lock"])
      if (existsSync(join(from, f)) && !existsSync(join(dir, f))) cpSync(join(from, f), join(dir, f));
  } catch {
    // opencode installs it itself
  }
}

/** Until opencode has installed its plugin package in ion's folder, a start can take long: said plainly. */
export const settingUp = (own = false): boolean => !installed(join(ionConfigHome(own), "opencode"));
