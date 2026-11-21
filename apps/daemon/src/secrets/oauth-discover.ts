import { UserError } from "../api/errors.js";
import { getJson, isLocal, type Net, post, type Reach, SAY, secureUrl, str, strs, vet } from "./oauth-net.js";

/** What a 401 said: where the server's protected-resource metadata is, and the scope it asks for. */
export type Challenge = { metadata?: string; scope?: string };

/** Where and how to sign in to a server (RFC 9728 + RFC 8414), every endpoint checked. */
export type Found = {
  issuer: string;
  authorize: URL;
  token: URL;
  register?: URL;
  /** The server, as the `resource` (RFC 8707) its tokens are for. */
  resource: string;
  scope?: string;
  authMethods?: string[];
  /** The server says which issuer answered (RFC 9207): the callback's `iss` must be it. */
  issParam: boolean;
  /** Where requests about this server may go (http and loopback only for a server on this computer). */
  reach: Reach;
};

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ion", version: "0" } },
});

/** The last word of a piece of a challenge ("Bearer scope" → "scope"), in lower case. */
const lastWord = (t: string) => (t.trim().split(" ").at(-1) ?? "").toLowerCase();

/** The `key=value` pairs outside quotes, into `out`; the key whose quoted value comes next, if one does. */
function bareParams(text: string, out: Map<string, string>): string | null {
  let waiting: string | null = null;
  for (const piece of text.split(",")) {
    const eq = piece.indexOf("=");
    if (eq < 0) continue;
    const value = piece.slice(eq + 1).trim();
    if (value) out.set(lastWord(piece.slice(0, eq)), value);
    waiting = value ? null : lastWord(piece.slice(0, eq));
  }
  return waiting;
}

/** A challenge's `key=value` and `key="value"` pairs, by key: the text between quotes is taken as it is. */
function paramsOf(header: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = header.split('"');
  let waiting: string | null = null;
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      if (waiting) out.set(waiting, parts[i]!);
      waiting = null;
      continue;
    }
    waiting = bareParams(parts[i]!, out);
  }
  return out;
}

/** A Bearer challenge's parameters (RFC 6750 §3), or null when it isn't one. */
export function challengeOf(header: string | null): Challenge | null {
  if (!header?.trimStart().toLowerCase().startsWith("bearer")) return null;
  const params = paramsOf(header);
  const metadata = params.get("resource_metadata");
  const scope = params.get("scope");
  return { ...(metadata ? { metadata } : {}), ...(scope ? { scope } : {}) };
}

/** The text without trailing slashes. */
function trimSlashes(t: string): string {
  let end = t.length;
  while (end > 0 && t[end - 1] === "/") end--;
  return t.slice(0, end);
}

/** Its path without a trailing slash ("" for the root). */
const pathOf = (u: URL) => trimSlashes(u.pathname);

/** The protected-resource metadata: where the 401 said, else the well-known places (RFC 9728 §3). */
async function resourceMetadata(net: Net, server: URL, reach: Reach, hint?: string) {
  const tries: URL[] = [];
  if (hint) tries.push(secureUrl(hint, reach));
  const path = pathOf(server);
  if (path) tries.push(new URL(`/.well-known/oauth-protected-resource${path}`, server.origin));
  tries.push(new URL("/.well-known/oauth-protected-resource", server.origin));
  for (const u of tries) {
    const m = await getJson(net, u, reach);
    if (m) return m;
  }
  return null;
}

/** The authorization server's metadata (RFC 8414, then OpenID discovery), at the places the MCP spec lists. */
async function serverMetadata(net: Net, issuer: URL, reach: Reach) {
  const path = pathOf(issuer);
  const tries = path
    ? [
        `/.well-known/oauth-authorization-server${path}`,
        `/.well-known/openid-configuration${path}`,
        `${path}/.well-known/openid-configuration`,
      ]
    : ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"];
  for (const p of tries) {
    const m = await getJson(net, new URL(p, issuer.origin), reach);
    if (m) return m;
  }
  return null;
}

/** Where requests about this server may go. */
export const reachOf = (server: URL): Reach => ({ local: isLocal(server) });

/**
 * Asks the server without a sign-in (an MCP `initialize`): its challenge if it answers 401 (empty when the 401
 * names nothing), null if it answers anything else or can't be reached.
 */
export async function probe(net: Net, server: URL): Promise<Challenge | null> {
  const reach = { ...reachOf(server), own: true };
  const r = await post(net, server, { body: INITIALIZE, type: "application/json", reach }).catch(() => null);
  if (!r) return null;
  return r.status === 401 ? (challengeOf(r.header("www-authenticate")) ?? {}) : null;
}

/** Whether a server needs signing in: it answers 401 with a Bearer challenge or has protected-resource metadata. */
export async function needsSignIn(net: Net, server: URL): Promise<boolean> {
  const c = await probe(net, server);
  if (!c) return false;
  if (c.metadata) return true;
  return (await resourceMetadata(net, server, reachOf(server)).catch(() => null)) !== null;
}

/**
 * The resource its tokens are for: the metadata's, which must be the server's URL it was fetched for (RFC 9728
 * §3.3); with no metadata (older servers), the server without its query.
 */
function resourceOf(server: URL, prm: Record<string, unknown> | null): string {
  const bare = `${server.origin}${server.pathname}`;
  if (!prm) return bare;
  const named = str(prm.resource);
  let href = "";
  try {
    href = new URL(named ?? "").href;
  } catch {
    throw new UserError(SAY.mismatch);
  }
  if (href !== server.href && href !== bare) throw new UserError(SAY.mismatch);
  return named!;
}

/** The authorization server the metadata names (the first), or the server's own origin (older servers). */
function issuerOf(server: URL, prm: Record<string, unknown> | null): string {
  if (!prm) return server.origin;
  const first = strs(prm.authorization_servers)?.[0];
  if (!first) throw new UserError(SAY.notFound);
  return first;
}

/**
 * The endpoints the metadata names, each secure: the issuer exactly the one asked about (RFC 8414 §3.3), and PKCE
 * with S256 (MCP 2025-11-25: refused when it isn't listed).
 */
function endpointsOf(issuer: string, m: Record<string, unknown>, reach: Reach) {
  if (str(m.issuer) !== issuer) throw new UserError(SAY.mismatch);
  if (!strs(m.code_challenge_methods_supported)?.includes("S256")) throw new UserError(SAY.noPkce);
  const register = str(m.registration_endpoint);
  return {
    authorize: secureUrl(m.authorization_endpoint, reach),
    token: secureUrl(m.token_endpoint, reach),
    ...(register ? { register: secureUrl(register, reach) } : {}),
  };
}

/** Where and how to sign in to `server`: refused plainly when anything on the way isn't secure or doesn't match. */
export async function discover(net: Net, server: URL, hint: Challenge): Promise<Found> {
  const reach = reachOf(server);
  secureUrl(server.href, { ...reach, own: true });
  const prm = await resourceMetadata(net, server, reach, hint.metadata);
  const resource = resourceOf(server, prm);
  const issuer = issuerOf(server, prm);
  const meta = await serverMetadata(net, secureUrl(issuer, reach), reach);
  if (!meta) throw new UserError(SAY.notFound);
  const ends = endpointsOf(issuer, meta, reach);
  // The endpoints ion itself calls are checked now, before anything is registered.
  await vet(net, ends.token, reach);
  if (ends.register) await vet(net, ends.register, reach);
  const scope = hint.scope ?? strs(prm?.scopes_supported)?.join(" ");
  const authMethods = strs(meta.token_endpoint_auth_methods_supported);
  return {
    issuer,
    ...ends,
    resource,
    reach,
    ...(scope ? { scope } : {}),
    ...(authMethods ? { authMethods } : {}),
    issParam: meta.authorization_response_iss_parameter_supported === true,
  };
}
