/**
 * What the app sees of a server from mcp.json: nothing that could be a secret you typed there (a password in a
 * URL, a token in an argument, a header's value). `${NAME}`s are names, so they show.
 */

const HIDDEN = "…";
/** A flag that names a secret: the value given to it isn't shown ("--api-key x"). */
const SECRET_FLAG = /^--?[\w-]*(token|key|secret|password|pass|auth)[\w-]*$/i;
const ONLY_REFS = /^(\$\{\w+(:-[^}]*)?\})+$/;
/** Key-like characters: base64, JWTs and API keys use these. */
const TOKEN = /^[\w.+/=-]{20,}$/;

/** A long word mixing letters and digits or cases: a key, not a name. */
export function looksLikeToken(s: string): boolean {
  if (!TOKEN.test(s)) return false;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/].filter((r) => r.test(s)).length;
  return kinds >= 2;
}

/** A URL's host (with its port): after the last "@" of its authority, so "user:p@ss@host" shows "host". */
export function shownHost(url: string): string {
  const authority = /^[a-z][\w+.-]*:\/\/([^/?#]*)/i.exec(url)?.[1] ?? "";
  return authority.slice(authority.lastIndexOf("@") + 1) || HIDDEN;
}

const HOST_PORT = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|[a-z\d-]+(?:\.[a-z\d-]+)+):(\d{1,5})$/i;
const SECRETISH = /token|key|secret|password|auth|bearer/i;

/** A host (localhost, an IPv4 address or a dotted name) and a port 1–65535: never a secret-named or key-like left. */
function isHostPort(a: string): boolean {
  const m = HOST_PORT.exec(a);
  if (!m) return false;
  const port = Number(m[2]);
  return port >= 1 && port <= 65535 && !SECRETISH.test(m[1]!) && !looksLikeToken(m[1]!);
}

/** The program's name, without its folder. */
export const shownCommand = (command: string): string => command.split("/").pop() || command;

/** "NAME=value" or "--flag=value" with its value hidden (a name, not a base64 key that ends in "="); else null. */
function shownAssign(a: string): string | null {
  const m = /^(-{0,2}[A-Za-z_][\w-]*)=(.*)$/s.exec(a);
  if (!m || looksLikeToken(m[1]!)) return null;
  return ONLY_REFS.test(m[2]!) ? a : `${m[1]}=${HIDDEN}`;
}

function shownArg(a: string, prev: string | undefined): string {
  if (ONLY_REFS.test(a)) return a;
  if (a.includes("://")) return shownHost(a);
  if (prev && SECRET_FLAG.test(prev) && !a.startsWith("-")) return HIDDEN;
  const assigned = shownAssign(a);
  if (assigned) return assigned;
  if (looksLikeToken(a)) return HIDDEN;
  return shownHeader(a) ?? (a.split("/").some(looksLikeToken) ? HIDDEN : a);
}

/** "Name:value" with its value hidden (not a host and port, "localhost:3000"); else null. */
function shownHeader(a: string): string | null {
  const m = isHostPort(a) ? null : /^([\w-]+):/.exec(a);
  if (!m) return null;
  return looksLikeToken(m[1]!) ? HIDDEN : `${m[1]}: ${HIDDEN}`;
}

/** Each argument, with anything that could be a secret hidden. */
export function shownArgs(args: string[]): string[] {
  return args.map((a, i) => shownArg(a, args[i - 1]));
}
