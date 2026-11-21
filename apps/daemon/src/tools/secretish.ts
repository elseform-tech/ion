import { looksLikeToken } from "./shown.js";

/**
 * Could a value typed into mcp.json be a key? Asked for the readable-by-others warning: its own question, not what
 * the app hides (a docs URL or MODE=fast isn't a key; GITHUB_TOKEN=abc is).
 */

const ONLY_REFS = /^(\$\{\w+(:-[^}]*)?\})*$/;
/** A name that says it holds a secret. */
const SECRET_NAME = /token|key|secret|password|passwd|pass|auth|bearer|credential/i;
const SECRET_FLAG = /^--?[\w-]*(token|key|secret|password|pass|auth)[\w-]*$/i;

const decoded = (v: string) => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

/** A URL with a user or password, a key-like path segment, or a query value typed in (not a `${NAME}`). */
export function urlHoldsKey(url: string): boolean {
  const start = url.indexOf("://") + 3;
  const end = url.slice(start).search(/[/?#]/);
  const authority = end < 0 ? url.slice(start) : url.slice(start, start + end);
  const rest = end < 0 ? "" : url.slice(start + end);
  const [path = "", query = ""] = rest.split("#")[0]!.split("?");
  const values = query.split("&").map((kv) => kv.slice(kv.indexOf("=") + 1));
  return (
    authority.includes("@") ||
    path.split("/").some(looksLikeToken) ||
    values.some((v) => v !== "" && !ONLY_REFS.test(decoded(v)))
  );
}

/** A value on its own: a key-like word (whole or in a path), "Bearer …", or a URL holding one. */
function couldBeKey(v: string): boolean {
  if (ONLY_REFS.test(v)) return false;
  if (v.includes("://")) return urlHoldsKey(v);
  if (/^bearer\s+\S/i.test(v)) return true;
  return looksLikeToken(v) || v.split(/[/\s]/).some(looksLikeToken);
}

/** A named value (env, header): a secret-named one typed in, or a value that could be a key. */
export const namedKey = (name: string, v: string): boolean =>
  !ONLY_REFS.test(v) && (SECRET_NAME.test(name) || couldBeKey(v));

/** The value given to a flag that names a secret (`--token x`, `--api-key /path`): a key unless it's `${NAME}`s. */
export const afterSecretFlag = (a: string, prev: string | undefined): boolean =>
  !!prev && SECRET_FLAG.test(prev) && !a.startsWith("-") && !ONLY_REFS.test(a);

/** An argument: "NAME=value" or "Name: value" judged by name and value, the one after a secret flag, or a key. */
export function argKey(a: string, prev: string | undefined): boolean {
  if (prev && SECRET_FLAG.test(prev) && !a.startsWith("-")) return !ONLY_REFS.test(a);
  const named = /^(-{0,2}[A-Za-z_][\w-]*)[=:]/.exec(a);
  if (named && !a.includes("://")) {
    const value = a.slice(named[0].length).trim();
    return namedKey(named[1]!, value) && !/^\d{1,5}$/.test(value);
  }
  return couldBeKey(a);
}
