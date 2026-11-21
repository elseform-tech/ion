import { UserError } from "../api/errors.js";
import { type Found, reachOf } from "./oauth-discover.js";
import { type Net, post, SAY, str } from "./oauth-net.js";

export type Client = {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  auth: "none" | "basic" | "post";
};

/** What's kept (in the vault): the client, where to refresh, and the tokens (none: sign in again). */
export type Kept = Client & {
  v: 1;
  issuer: string;
  token: string;
  resource: string;
  access?: string;
  refresh?: string;
  expiresAt?: number;
};

const FORM = "application/x-www-form-urlencoded";
/** A token with no expiry but a refresh token is taken to last an hour (Task review, 2026-11-20). */
const ASSUMED_S = 3600;
/** The only answers that mean a refresh token (or the client) is no good any more (RFC 6749 §5.2). */
const DEAD = new Set(["invalid_grant", "invalid_client", "unauthorized_client"]);

export function parseKept(raw: string | null): Kept | null {
  if (!raw) return null;
  try {
    const k = JSON.parse(raw) as Kept;
    return k?.v === 1 && typeof k.clientId === "string" && typeof k.token === "string" ? k : null;
  } catch {
    return null;
  }
}

/** How the client proves itself at the token endpoint: header and form fields. */
function clientAuth(c: Client): { headers: Record<string, string>; form: Record<string, string> } {
  if (c.auth === "basic" && c.clientSecret) {
    const pair = `${encodeURIComponent(c.clientId)}:${encodeURIComponent(c.clientSecret)}`;
    return { headers: { authorization: `Basic ${Buffer.from(pair).toString("base64")}` }, form: {} };
  }
  const form: Record<string, string> = { client_id: c.clientId };
  if (c.auth === "post" && c.clientSecret) form.client_secret = c.clientSecret;
  return { headers: {}, form };
}

/** A secret goes as HTTP Basic, unless the server only takes it in the form. */
const secretAuth = (methods?: string[]): Client["auth"] =>
  methods?.includes("client_secret_post") && !methods.includes("client_secret_basic") ? "post" : "basic";

/** A client ID you typed: one line, not too long. */
export function givenClient(
  given: { clientId?: string; clientSecret?: string },
  found: Found,
  redirectUri: string,
): Client {
  const clientId = String(given.clientId ?? "").trim();
  const clientSecret = given.clientSecret === undefined ? "" : String(given.clientSecret).trim();
  const bad = (t: string) => t.length > 2000 || /\p{Cc}/u.test(t);
  if (!clientId || bad(clientId) || bad(clientSecret)) throw new UserError(needsClient(redirectUri));
  if (!clientSecret) return { clientId, redirectUri, auth: "none" };
  return { clientId, clientSecret, redirectUri, auth: secretAuth(found.authMethods) };
}

/** Asked for when the server can't register ion: with the exact redirect URI to register. */
const needsClient = (redirectUri: string) =>
  `This server needs a client ID. Register ion with ${redirectUri}`;

/** Registers ion with the server (RFC 7591) as a public client that comes back to the callback's port. */
export async function register(net: Net, found: Found, redirectUri: string): Promise<Client> {
  if (!found.register) throw new UserError(needsClient(redirectUri));
  const body = JSON.stringify({
    client_name: "ion",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
  const r = await post(net, found.register, { body, type: "application/json", reach: found.reach });
  const clientId = str(r.json?.client_id);
  if (r.status >= 300 || !clientId) throw new UserError(SAY.refused);
  const clientSecret = str(r.json?.client_secret);
  if (!clientSecret) return { clientId, redirectUri, auth: "none" };
  const said = str(r.json?.token_endpoint_auth_method);
  const auth = said === "client_secret_post" ? "post" : secretAuth(found.authMethods);
  return { clientId, clientSecret, redirectUri, auth };
}

export type Got = { access: string; refresh?: string; expiresIn?: number };

/** Tokens from a 200 answer, or null when it isn't a Bearer token in JSON. */
function gotOf(json: Record<string, unknown> | null): Got | null {
  const access = str(json?.access_token);
  const type = str(json?.token_type);
  if (!access || (type && type.toLowerCase() !== "bearer")) return null;
  const refresh = str(json?.refresh_token);
  const expiresIn = typeof json?.expires_in === "number" ? json.expires_in : undefined;
  return { access, ...(refresh ? { refresh } : {}), ...(expiresIn !== undefined ? { expiresIn } : {}) };
}

/**
 * The token endpoint's answer: the tokens; "dead" only when it says the grant or client is no good (400/401 with
 * invalid_grant, invalid_client, unauthorized_client); anything else (a network failure, 429, 5xx, a redirect, a page
 * that isn't JSON) is "unreachable": try again later.
 */
export async function tokenCall(
  net: Net,
  token: string,
  c: Client & { resource: string },
  grant: Record<string, string>,
): Promise<Got | "dead" | "unreachable"> {
  const a = clientAuth(c);
  const body = new URLSearchParams({ ...grant, ...a.form }).toString();
  const reach = reachOf(new URL(c.resource));
  const r = await post(net, new URL(token), { body, type: FORM, headers: a.headers, reach }).catch(
    () => null,
  );
  if (!r) return "unreachable";
  if ((r.status === 400 || r.status === 401) && DEAD.has(str(r.json?.error) ?? "")) return "dead";
  return (r.status === 200 && gotOf(r.json)) || "unreachable";
}

/** What's kept after a token call: new tokens, the refresh token kept when none came. */
export function withTokens(k: Kept, got: Got, now: number): Kept {
  const refresh = got.refresh ?? k.refresh;
  const seconds = got.expiresIn ?? (refresh ? ASSUMED_S : undefined);
  const kept: Kept = { ...withoutTokens(k), access: got.access };
  if (refresh) kept.refresh = refresh;
  if (seconds !== undefined) kept.expiresAt = now + seconds * 1000;
  return kept;
}

/** What's kept without its tokens: the client stays, so signing in again needs nothing more. */
export function withoutTokens(k: Kept): Kept {
  const rest = { ...k };
  delete rest.access;
  delete rest.refresh;
  delete rest.expiresAt;
  return rest;
}
