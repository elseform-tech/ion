/**
 * Every variable ion sets for one run's agent process (a gate address with its key, the chat marker, the run's key
 * for ion's commands, opencode's per-run config, a Grok trust flag). A daemon started from a run's tool call inherits
 * them; the daemon drops them so nothing it starts later carries another run's address or key.
 */
export const RUN_ENV_VARS = [
  "ION_CHAT",
  "ION_RUN_KEY",
  "ION_PORT",
  "ION_GATE_URL",
  "GROK_FOLDER_TRUST",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  // Not a run's, but never inherited either: where ion reads agents' configs and rules (the tour's; read once at start).
  "ION_AGENTS_HOME",
] as const;

/** Per-run variables named with this prefix (`ION_MCP_H<i>`: an ion MCP key header, one per header). */
export const RUN_ENV_PREFIXES = ["ION_MCP_"] as const;

/** What an agent's process may not inherit from ion's environment: the names mcp.json uses, and your keys' values. */
export type EnvDrop = { names: string[]; values: string[] };

/**
 * Variables every agent needs to run and sign in (its PATH, home, user, shell, locale, temp folder, its own config
 * folder, the network's proxy): never left out, even when mcp.json names one (`${HOME}/docs`) or a key equals one.
 */
const STANDARD = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TERM",
  "PWD",
  "SSH_AUTH_SOCK",
  "CODEX_HOME",
  "GROK_HOME",
  "CLAUDE_CONFIG_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SYSTEMROOT",
]);
const STANDARD_PREFIXES = ["LC_", "XDG_", "__CF_"];

/** Whether a variable is one every agent needs (never left out of its environment). */
export const isStandardEnv = (name: string): boolean =>
  STANDARD.has(name.toUpperCase()) || STANDARD_PREFIXES.some((p) => name.toUpperCase().startsWith(p));

/** Values this short are ordinary words, not keys: never matched. */
const KEY_MIN = 8;

let standing: (() => EnvDrop) | undefined;
let warned = false;

/**
 * What no agent process may inherit, whoever starts it (a version check, a model list, a login): the daemon sets it
 * at its start, from your mcp.json, before any agent starts; every `agentEnv` leaves it out too.
 */
export function setStandingDrop(fn: (() => EnvDrop) | undefined): void {
  standing = fn;
  warned = false;
}

/**
 * The daemon's standing drop; without one (never registered), ion's own run variables at least, said once: never the
 * environment untouched.
 */
function standingDrop(): EnvDrop {
  if (standing) return standing();
  if (!warned)
    console.warn("ion: no list of your keys to keep from agents yet; leaving out ion's own variables only");
  warned = true;
  return { names: [], values: [] };
}

/** ion's own per-run variables (and any `ION_MCP_*`): never inherited by an agent. */
const runOwn = (k: string) =>
  (RUN_ENV_VARS as readonly string[]).includes(k) || RUN_ENV_PREFIXES.some((p) => k.startsWith(p));

/**
 * The environment an agent's process starts from: ion's own (`base`), less every variable mcp.json names (a key
 * filled from ion's environment) and any variable holding one of the run's keys or tokens. The agent reaches your
 * servers through ion, which adds them.
 */
export function agentEnv(base: NodeJS.ProcessEnv = process.env, drop?: EnvDrop): NodeJS.ProcessEnv {
  const all = [drop, standingDrop()].filter((d): d is EnvDrop => !!d);
  const names = new Set(all.flatMap((d) => d.names).filter((n) => !isStandardEnv(n)));
  const values = new Set(all.flatMap((d) => d.values).filter((v) => v.length >= KEY_MIN));
  return Object.fromEntries(
    Object.entries(base).filter(
      ([k, v]) => !runOwn(k) && (isStandardEnv(k) || (!names.has(k) && !(v !== undefined && values.has(v)))),
    ),
  );
}
