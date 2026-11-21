import { readFileSync } from "node:fs";
import { type EnvDrop, isStandardEnv } from "@ion/adapter-kit";
import { mcpFileOf } from "@ion/config";
import { fillServer, type Lookup, refsInText, refsOf } from "./fill.js";
import { type McpServer, parseMcp } from "./mcp-file.js";
import { SECRET_MIN } from "./run-servers.js";

/** Where `${NAME}`s are filled from: your keys (keychain) then ion's environment; set by the daemon at its start. */
let lookup: Lookup | undefined;

export function setDropLookup(l: Lookup | undefined): void {
  lookup = l;
}

const envOnly: Lookup = async (name) => process.env[name] ?? null;
const keyName = (n: string) => !/^ion_/i.test(n) && !isStandardEnv(n);

function readFile(configFile: string): string {
  try {
    return readFileSync(mcpFileOf(configFile), "utf8");
  } catch {
    return ""; // No mcp.json yet: nothing to leave out.
  }
}

/**
 * Every `${NAME}` mcp.json uses (on or off; never ion's own `ION_*` nor a standard variable such as HOME): read
 * from the parsed file the way filling reads it (escapes and all), and from its raw text too (a broken file).
 */
function namesIn(text: string) {
  const servers = parseMcp(text).servers;
  const names = [...new Set([...servers.flatMap(refsOf), ...refsInText(text)])].filter(keyName);
  return { servers, names };
}

/** A filled server's header or env values. */
const valuesGiven = (s: McpServer): string[] => Object.values(s.transport === "http" ? s.headers : s.env);

/** A name's value for a server (none: ion's environment), never an error (a keychain that can't be read: the environment). */
const valueOf = (l: Lookup, name: string, server?: string) =>
  l(name, server).catch(() => process.env[name] ?? null);

/**
 * What no agent ion starts may inherit from ion's environment: every name mcp.json uses, and any variable holding a
 * key's value or what a server is filled with from it (a header, a "Bearer …", an env value), 8+ characters.
 */
export async function envDropOf(configFile: string): Promise<EnvDrop> {
  const l = lookup ?? envOnly;
  const { servers, names } = namesIn(readFile(configFile));
  const own = servers.flatMap((s) =>
    refsOf(s)
      .filter(keyName)
      .map((n) => valueOf(l, n, s.name)),
  );
  const keys = await Promise.all([...names.map((n) => valueOf(l, n)), ...own]);
  const filled = await Promise.all(
    servers.filter((s) => refsOf(s).some(keyName)).map((s) => fillServer(s, l).catch(() => null)),
  );
  const given = filled.flatMap((r) => (r && "server" in r ? valuesGiven(r.server) : []));
  const real = keys.filter((v): v is string => !!v && v.length >= SECRET_MIN);
  // Only what was made from a key (a "Bearer …" header), never a value filled from HOME alone.
  const made = given.filter((v) => real.some((k) => v.includes(k)));
  const values = [...real, ...made, ...made.map((v) => v.replace(/^Bearer\s+/i, ""))];
  return { names, values: [...new Set(values)].filter((v) => v.length >= SECRET_MIN) };
}

/**
 * The daemon's standing drop (adapter-kit's, for agents started outside a run: version checks, model lists,
 * logins). Answers at once from what it last read (to start with: mcp.json's names and ion's environment), and
 * reads again in the background each time it's asked.
 */
export function standingDropOf(configFile: string): () => EnvDrop {
  const { names } = namesIn(readFile(configFile));
  const now = names.map((n) => process.env[n] ?? "").filter((v) => v.length >= SECRET_MIN);
  let last: EnvDrop = { names, values: now };
  let reading = false;
  return () => {
    if (!reading) {
      reading = true;
      void envDropOf(configFile)
        .then((d) => {
          last = d;
        })
        .catch(() => {})
        .finally(() => {
          reading = false;
        });
    }
    return last;
  };
}
