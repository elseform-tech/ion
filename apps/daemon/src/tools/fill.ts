import { KeychainError, keyAccount, type Secrets } from "../secrets/index.js";
import type { McpServer } from "./mcp-file.js";

/** `${NAME}` or `${NAME:-default}`, as Claude Code's .mcp.json takes them. */
const REF = /\$\{([A-Za-z_]\w*)(?::-([^}]*))?\}/g;
/** ion's own variables (its daemon token, gate and MCP keys): never given to a server. */
const ION_OWN = /^ion_/i;
/** Filled per run by ion's bridge (the chat's folder), never looked up: a local server that needs the worktree. */
const PER_RUN = "ION_WORKTREE";

/**
 * A `${NAME}`'s value for a server, or null when there's none; throws a KeychainError when only the keychain could
 * say. Without a server: ion's environment only.
 */
export type Lookup = (name: string, server?: string) => Promise<string | null>;

/**
 * The key you entered in the app for this server and name (keychain), else ion's environment; never one of ion's
 * own. Keys belong to their server (a key given to one never reaches another naming the same ${NAME}); an old item
 * kept by name alone is never read.
 */
export const lookupIn =
  (secrets: Secrets, env: NodeJS.ProcessEnv = process.env): Lookup =>
  async (name, server) => {
    if (ION_OWN.test(name)) return null;
    try {
      const own = server === undefined ? null : await secrets.get(keyAccount(server, name));
      return own ?? env[name] ?? null;
    } catch (e) {
      if (env[name] !== undefined) return env[name];
      throw e;
    }
  };

const textsOf = (s: McpServer): string[] =>
  s.transport === "http"
    ? [s.url, ...Object.values(s.headers)]
    : [s.command, ...s.args, ...Object.values(s.env)];

const refsIn = (s: McpServer) =>
  textsOf(s)
    .flatMap((t) => [...t.matchAll(REF)])
    .filter((m) => m[1] !== PER_RUN);

/** Every `${NAME}` written anywhere in a text (all of mcp.json, say), once each. */
export const refsInText = (text: string): string[] => [...new Set([...text.matchAll(REF)].map((m) => m[1]!))];

/** Every `${NAME}` the server uses, once each, in order. */
export function refsOf(s: McpServer): string[] {
  return [...new Set(refsIn(s).map((m) => m[1]!))];
}

/** The names that have a default (`${NAME:-x}`): never missing. */
const defaults = (s: McpServer) =>
  new Set(
    refsIn(s)
      .filter((m) => m[2] !== undefined)
      .map((m) => m[1]!),
  );

const mapValues = (o: Record<string, string>, f: (v: string) => string) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]));

/** Each name's value (null: none); a keychain that can't be read is said once. */
async function valuesOf(s: McpServer, lookup: Lookup) {
  const values = new Map<string, string | null>();
  let keychain: string | undefined;
  for (const name of refsOf(s)) {
    try {
      values.set(name, await lookup(name, s.name));
    } catch (e) {
      if (!(e instanceof KeychainError)) throw e;
      keychain = e.message;
      values.set(name, null);
    }
  }
  return { values, keychain };
}

/**
 * Which keys it still needs: names with no value (and no default), names only the keychain could answer for while
 * it can't be read, and why.
 */
export async function keysNeeded(
  s: McpServer,
  lookup: Lookup,
): Promise<{ missing: string[]; unread: string[]; keychain?: string }> {
  const withDefault = defaults(s);
  const missing: string[] = [];
  const unread: string[] = [];
  let keychain: string | undefined;
  for (const name of refsOf(s).filter((n) => !withDefault.has(n))) {
    try {
      if ((await lookup(name, s.name)) === null) missing.push(name);
    } catch (e) {
      if (!(e instanceof KeychainError)) throw e;
      unread.push(name);
      keychain = e.message;
    }
  }
  return { missing, unread, ...(keychain ? { keychain } : {}) };
}

/**
 * The server with each `${NAME}` filled in, or the names that have no value (never a value), and why the keychain
 * couldn't say, if it couldn't.
 */
export async function fillServer(
  s: McpServer,
  lookup: Lookup,
): Promise<{ server: McpServer } | { missing: string[]; keychain?: string }> {
  const { values, keychain } = await valuesOf(s, lookup);
  const withDefault = defaults(s);
  const missing = [...values].filter(([n, v]) => v === null && !withDefault.has(n)).map(([n]) => n);
  if (missing.length) return { missing, ...(keychain ? { keychain } : {}) };
  const fill = (t: string) =>
    t.replace(REF, (m, name: string, dflt?: string) =>
      name === PER_RUN ? m : (values.get(name) ?? dflt ?? ""),
    );
  const server: McpServer =
    s.transport === "http"
      ? { ...s, url: fill(s.url), headers: mapValues(s.headers, fill) }
      : { ...s, command: fill(s.command), args: s.args.map(fill), env: mapValues(s.env, fill) };
  return { server };
}
