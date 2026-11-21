import { isStandardEnv, type McpSpec, type McpTransports } from "@ion/adapter-kit";
import { loadUserConfig } from "@ion/config";
import type { OAuth } from "../secrets/oauth.js";
import { fillServer, refsOf } from "./fill.js";
import type { Tools } from "./index.js";
import type { McpServer } from "./mcp-file.js";
import { consentOf, turnedOn } from "./on.js";

/** A server a run goes without, and why, in a line for its chat (its name only, never a value). */
type Skipped = { id: string; text: string };

/**
 * A chat run's servers (yours, after ion's own), the ones it goes without, and every key and token they were given
 * (the run redacts these from all it stores).
 */
export type RunServers = {
  specs: McpSpec[];
  skipped: Skipped[];
  secrets: string[];
  /** For each remote server you signed in to: a token fresh for now (ion's gateway asks before each request). */
  fresh: Record<string, () => Promise<string | null>>;
  /** Every `${NAME}` in mcp.json, on or off (never ion's own): the agent's process doesn't inherit these. */
  refs: string[];
};

/** The agent a run is on: its name and the kinds of server it takes. */
export type RunAgent = { label: string; takes: McpTransports };

const without = (id: string, why: string): Skipped => ({
  id,
  text: `${why}, so this chat runs without it.`,
});

type Deps = { tools: Tools; oauth: Pick<OAuth, "status" | "freshToken">; configFile: string };

/** A header that holds a key: a `${NAME}` filled from your keys or ion's environment, or an Authorization one. */
const holdsKey = (raw: McpServer & { transport: "http" }) =>
  Object.entries(raw.headers).some(([k, v]) => v.includes("${") || k.toLowerCase() === "authorization");

/**
 * A remote server whose headers hold no key and that asks for a sign-in gets a fresh token (refreshed if it's about
 * to expire) beside its own headers; none (never signed in, sign in again, its sign-in can't be reached) means the
 * run goes without it.
 */
async function signedIn(
  d: Deps,
  raw: McpServer & { transport: "http" },
  s: McpServer & { transport: "http" },
): Promise<Given | Skipped> {
  const spec: McpSpec = { ...s };
  if (holdsKey(raw)) return spec;
  const status = await d.oauth.status(s.name, { probe: true });
  if (!status) return spec;
  const token = status === "sign in" ? null : await d.oauth.freshToken(s.name);
  if (token) return { ...spec, headers: { ...s.headers, Authorization: `Bearer ${token}` }, oauth: true };
  const now = status === "sign in" ? status : await d.oauth.status(s.name);
  return now === "sign in" || now === "sign in again"
    ? without(s.name, `${s.name} isn't signed in`)
    : without(s.name, `${s.name} can't be reached`);
}

/** A server as given to the run; `oauth`: its Authorization is a token from your sign-in. */
type Given = McpSpec & { oauth?: true };

/** One server you turned on, as the run gets it, or why it goes without. */
async function specOf(d: Deps, s: McpServer, agent: RunAgent): Promise<Given | Skipped> {
  // Every server reaches the agent at ion's URL for it (a local one ion runs itself): the agent needs only http.
  if (!agent.takes.http) return without(s.name, `${agent.label} can't use ${s.name}`);
  const filled = await fillServer(s, d.tools.lookup).catch(() => ({ missing: [], keychain: "" }));
  if ("keychain" in filled) return without(s.name, `ion can't read your keychain for ${s.name}`);
  if (!("server" in filled)) return without(s.name, `${s.name} needs a key`);
  const f = filled.server;
  return f.transport === "http" && s.transport === "http" ? signedIn(d, s, f) : { ...f };
}

/** Values long enough to redact without hiding ordinary words. */
export const SECRET_MIN = 8;

/** The keys and tokens a server was given: its header and env values, a bearer's token, and each `${NAME}`'s value. */
async function secretsOf(d: Deps, raw: McpServer, spec: McpSpec): Promise<string[]> {
  const given = Object.values(spec.transport === "http" ? spec.headers : spec.env);
  const bearers = given.map((v) => v.replace(/^Bearer\s+/i, ""));
  // A standard variable's value (`${HOME}`) isn't a key: never redacted or left out.
  const named = refsOf(raw).filter((n) => !isStandardEnv(n));
  const refs = await Promise.all(named.map((n) => d.tools.lookup(n, raw.name).catch(() => null)));
  return [...given, ...bearers, ...refs].filter((v): v is string => !!v && v.length >= SECRET_MIN);
}

/**
 * Your servers for a chat's run, read at its start (it keeps them through its retries): the ones you turned on that
 * still run what you turned on, with their `${NAME}`s filled and a fresh token for one you signed in to. Never for
 * ion's own turns or the judge.
 */
export function serversFor(d: Deps): (agent: RunAgent) => Promise<RunServers> {
  return async (agent) => {
    const on = turnedOn(loadUserConfig(d.configFile).config.tools.mcpOn);
    const all = d.tools.read().servers;
    const refs = [...new Set(all.flatMap(refsOf))].filter((n) => !/^ion_/i.test(n) && !isStandardEnv(n));
    const out: RunServers = { specs: [], skipped: [], secrets: [], fresh: {}, refs };
    for (const s of all) {
      if (!(await consentOf(d.tools, s, on)).on) continue;
      const r = await specOf(d, s, agent);
      if ("text" in r) out.skipped.push(r);
      else {
        const { oauth, ...spec } = r;
        out.specs.push(spec as McpSpec);
        if (oauth) out.fresh[s.name] = () => d.oauth.freshToken(s.name);
        out.secrets.push(...(await secretsOf(d, s, spec as McpSpec)));
      }
    }
    out.secrets = [...new Set(out.secrets)];
    return out;
  };
}
