import { createHash, randomUUID } from "node:crypto";
import {
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
import { parseJsonc } from "@ion/adapter-kit";

/**
 * Only ion's tools in ion's chats (the user, 2026-11-21: "Only ion's, plus Import"). opencode loads servers and
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

/** Without its servers and plugins. */
function withoutTools(c: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...c };
  delete rest.mcp;
  delete rest.plugin;
  return rest;
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

/** Your config file as ion carries it: no servers or plugins, file references and instructions made whole. */
function carried(c: Record<string, unknown>, dir: string): Record<string, unknown> {
  const out = wholeFiles(withoutTools(c), dir) as Record<string, unknown>;
  if (Array.isArray(out.instructions))
    out.instructions = out.instructions.map((x) => (typeof x === "string" && relative(x) ? join(dir, x) : x));
  return out;
}

/**
 * What your opencode config says besides servers and plugins (your folder's files, then an inline config in ion's
 * environment), plus `~/.opencode`'s servers, each turned off: the base of the config ion writes for opencode.
 */
export function carriedConfig(): Record<string, unknown> {
  const dir = join(userConfigHome(), "opencode");
  let base: Record<string, unknown> = {};
  for (const f of FILES) base = merge(base, carried(readConfig(join(dir, f)), dir));
  let inline: unknown = null;
  try {
    inline = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}");
  } catch {
    // ignore an unreadable inline config; ion's permissions still apply
  }
  if (isObject(inline)) base = merge(base, withoutTools(inline));
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
const ionConfigHome = (): string => {
  const home = process.env.ION_HOME;
  const key = home ? createHash("sha256").update(resolve(home)).digest("hex").slice(0, 12) : "default";
  return join(ionCache(), "opencode", key);
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
export function writeIonConfig(config: Record<string, unknown>): string {
  const home = ionConfigHome();
  const cache = ionCache();
  mkdirSync(dirname(cache), { recursive: true, mode: 0o700 });
  for (const p of [cache, dirname(home), home, join(home, "opencode")]) ownFolder(p);
  const dir = join(home, "opencode");
  for (const name of readdirSync(dir))
    if (!KEEP.has(name)) rmSync(join(dir, name), { recursive: true, force: true });
  onlyPluginPackage(join(dir, "package.json"));
  writeWhole(join(dir, "opencode.json"), `${JSON.stringify(config, null, 2)}\n`);
  return home;
}

/** Until opencode has installed its plugin package in ion's folder, a start can take long: said plainly. */
export const settingUp = (): boolean =>
  !existsSync(join(ionConfigHome(), "opencode", "node_modules", PLUGIN_PACKAGE));
