import { mcpFileOf } from "@ion/config";
import { createSigner, type Sign } from "../secrets/consent-key.js";
import { keyAccount, oauthAccount, type Secrets } from "../secrets/index.js";
import { fillServer, type Lookup, lookupIn, refsOf } from "./fill.js";
import { McpFile, type McpRead, type McpServer } from "./mcp-file.js";

export { keysNeeded, refsOf } from "./fill.js";
export type { McpServer } from "./mcp-file.js";
export { shownArgs, shownCommand, shownHost } from "./shown.js";

export const EXPOSED = "mcp.json can be read by other users on this computer";

/** Your connections (mcp.json) and where their keys and tokens are kept. */
export type Tools = {
  file: McpFile;
  secrets: Secrets;
  /** Where OAuth tokens are kept (the vault: too big for the keychain). */
  tokens: Secrets;
  read(): McpRead;
  lookup: Lookup;
  /** What you consent to when you turn it on: all it runs with, as written in mcp.json, signed with ion's own key. */
  consent(s: McpServer): Promise<string>;
  /** Signs a consent record with this install's key (hooks use it too): a record written by hand never verifies. */
  sign: Sign;
  /** Where its tokens are kept: bound to the origin of its URL as filled in. */
  tokenAccount(s: McpServer): Promise<string>;
  /** A remote server by name: its URL as filled in, and where its tokens are kept. Null for any other. */
  remote(name: string): Promise<{ url: string; account: string } | null>;
};

/** A remote server's URL with its `${NAME}`s filled in where they can be (else as written). */
async function filledUrl(s: McpServer & { transport: "http" }, lookup: Lookup): Promise<string> {
  const r = await fillServer(s, lookup).catch(() => null);
  return r && "server" in r && r.server.transport === "http" ? r.server.url : s.url;
}

/**
 * mcp.json beside the config file. A server that leaves it (or points somewhere else) loses its sign-in; a server
 * left out, a broken file, or one others can read with keys in it is said once in the daemon's log, by name and
 * reason only.
 */
export function createTools(o: { configFile: string; secrets: Secrets; tokens?: Secrets }): Tools {
  const tokens = o.tokens ?? o.secrets;
  const lookup = lookupIn(o.secrets);
  const tokenAccount = async (s: McpServer) =>
    oauthAccount(s.name, s.transport === "http" ? await filledUrl(s, lookup) : s.command);
  const file = new McpFile(mcpFileOf(o.configFile), {
    // A server that points somewhere else (or is left out) loses its sign-in; one removed from the file, its keys too.
    // Keys stay through an edit: the server is off until you turn it on again anyway.
    onGone: (was, removed) =>
      void tokenAccount(was)
        .then((a) =>
          Promise.all([
            tokens.remove(a),
            o.secrets.remove(a),
            ...(removed ? refsOf(was).map((n) => o.secrets.remove(keyAccount(was.name, n))) : []),
          ]),
        )
        .catch(() => {}),
  });
  let said = "";
  const sign = createSigner(tokens);
  return {
    sign,
    file,
    secrets: o.secrets,
    tokens,
    lookup,
    tokenAccount,
    async remote(name) {
      const s = file.read().servers.find((x) => x.name === name);
      if (s?.transport !== "http") return null;
      return { url: await filledUrl(s, lookup), account: await tokenAccount(s) };
    },
    // Everything it runs with, as written: command, arguments and env; or the URL and headers.
    consent: (s) =>
      sign(
        `mcp:${JSON.stringify([s.name, ...(s.transport === "http" ? [s.url, s.headers] : [s.command, s.args, s.env])])}`,
      ),
    read() {
      const r = file.read();
      const lines = [
        ...r.leftOut.map((l) => `mcp.json: ${l.name} left out: ${l.why}`),
        ...(r.problem ? [r.problem] : []),
        ...(r.exposed ? [EXPOSED] : []),
      ];
      const now = lines.join("\n");
      if (now && now !== said) console.warn(now);
      said = now;
      return r;
    },
  };
}
