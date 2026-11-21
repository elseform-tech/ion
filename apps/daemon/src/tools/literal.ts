import { afterSecretFlag, argKey, namedKey, urlHoldsKey } from "./secretish.js";

/** What `ion <kind> add` says to a key typed in: keys go in Settings, mcp.json names them with `${NAME}`. */
const PUT_KEYS_IN_SETTINGS = "Put keys in Settings";

/** How common keys start: OpenAI/Anthropic, GitHub, Slack, AWS, GitLab, Google. */
const KEY_PREFIX = /^(sk-|sk_|rk_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[abposr]-|AKIA|ASIA|glpat-|AIza)/;
/** A long run of key characters with letters and digits mixed: a token, whatever it's called. */
const LONG_TOKEN = /^[\w+/=.-]{32,}$/;
const mixed = (s: string) => [/[a-z]/, /[A-Z]/, /\d/].filter((r) => r.test(s)).length >= 2;

/** A word that is a key by its look alone (a prefix keys use, or a long mixed token). */
const keyLike = (w: string) => KEY_PREFIX.test(w) || (LONG_TOKEN.test(w) && mixed(w));

/** A header or env value: only `${NAME}`s (a "Bearer " before one is fine), never a key typed in. */
const literalValue = (name: string, v: string) => {
  const rest = v.replace(/^\s*bearer\s+/i, "");
  return namedKey(name, rest) || rest.split(/[\s:=]/).some(keyLike);
};

/** A word, or any part of a path in it (a program's folder isn't a key; a key in a path still is). */
const holdsKeyLike = (w: string) => w.split("/").some(keyLike);

/** A file's path (judged by its parts, never as one long token). */
const isPath = (w: string) => /^(\/|\.\.?\/|~\/)/.test(w);

/**
 * Each word of a command (a hook's, or a server's arguments), judged with the one before it. A path is judged by
 * its parts, and as a secret flag's value (Task review, 2026-11-21), never as one long token.
 */
const literalWords = (words: string[]) =>
  words.some(
    (w, i) =>
      holdsKeyLike(w) ||
      holdsKeyLike(w.replace(/^[^=]*=/, "")) ||
      (isPath(w) ? afterSecretFlag(w, words[i - 1]) : argKey(w, words[i - 1])),
  );

/** Why what's being added can't be: a key typed in (anywhere ion would keep or show it), else null. */
export function literalKey(x: {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  url?: string;
  run?: string;
}): string | null {
  const named = [...Object.entries(x.env ?? {}), ...Object.entries(x.headers ?? {})];
  const found =
    named.some(([k, v]) => literalValue(k, v)) ||
    literalWords([...(x.command ? [x.command] : []), ...(x.args ?? [])]) ||
    literalWords(x.run?.split(/\s+/).filter(Boolean) ?? []) ||
    (x.url !== undefined && urlHoldsKey(x.url));
  return found ? PUT_KEYS_IN_SETTINGS : null;
}
