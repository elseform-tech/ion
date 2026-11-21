import { createHash, randomBytes } from "node:crypto";
import { EV, type EventType, type NewEvent } from "@ion/schema";
import { UserError } from "../api/errors.js";
import { KeychainError, type Secrets } from "./index.js";
import { CallbackPort } from "./oauth-callback.js";
import { discover, type Found, needsSignIn, probe } from "./oauth-discover.js";
import { type Net, SAY, systemNet } from "./oauth-net.js";
import {
  type Client,
  givenClient,
  type Kept,
  parseKept,
  register,
  tokenCall,
  withoutTokens,
  withTokens,
} from "./oauth-tokens.js";

/**
 * ion signs in to remote MCP servers as the MCP authorization spec asks: protected-resource metadata (RFC 9728) →
 * authorization-server metadata (RFC 8414) → dynamic registration (RFC 7591) → authorization code with PKCE (S256)
 * for the server as the `resource` (RFC 8707), back to ion's own callback port on 127.0.0.1. Tokens are kept in the
 * vault only, refreshed before they expire, and never put in an event, the log, an error or the app.
 */
export type OAuth = {
  /** Whether a remote server asks for a sign-in (it answers 401 the standard way). */
  detect(url: string): Promise<boolean>;
  /**
   * Where a connection's sign-in stands: kept tokens, kept but dead (sign in again), kept but its sign-in couldn't
   * be reached since the token expired; with `probe`, a server with nothing kept is asked whether it needs one.
   * Null: it doesn't (or can't say).
   */
  status(id: string, o?: { probe?: boolean }): Promise<SignInStatus | null>;
  /** The page to open in your browser to sign in. Stores nothing until you're signed in. */
  signIn(id: string, given?: { clientId?: string; clientSecret?: string }): Promise<{ url: string }>;
  /** The browser came back: the plain page to show it. */
  callback(q: URLSearchParams): Promise<{ ok: boolean; page: string }>;
  /** A token good for at least a minute (refreshed if needed), or null: not signed in, needs it again, can't reach. */
  freshToken(id: string): Promise<string | null>;
  signOut(id: string): Promise<void>;
  /** Stops waiting for sign-ins (the callback port closes). */
  close(): Promise<void>;
};

type SignInStatus = "signed in" | "sign in again" | "sign in" | "can't reach";

export type OAuthDeps = {
  /** Where tokens are kept: the vault (they're too big for the keychain). */
  secrets: Secrets;
  store: { append(e: NewEvent): unknown };
  /** A remote connection by name: its URL (filled in) and the account its tokens are kept under. */
  resolve(id: string): Promise<{ url: string; account: string } | null>;
  /** The callback's ports, first free one taken (tests: their own). */
  ports?: number[];
  net?: Net;
  now?: () => number;
  /** How long a sign-in link lasts (tests: shorter). */
  stateMs?: number;
};

type Flow = {
  id: string;
  account: string;
  origin: string;
  expires: number;
  verifier: string;
  found: Found;
  client: Client;
  timer: ReturnType<typeof setTimeout>;
};

const STATE_MS = 10 * 60_000;
const EARLY_MS = 60_000;
const DETECT_MS = 5 * 60_000;
const OLD = "That sign-in link is old. Try again from ion.";
const NOT_DONE = "Sign-in didn't finish. Try again from ion.";
const DONE = "Signed in. You can close this tab.";
const NO_PORT = "ion couldn't open a port to finish signing in";

const b64url = (b: Buffer) => b.toString("base64url");
const escapeHtml = (t: string) => t.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);

/** A small plain page: no script, the text escaped. */
const page = (text: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ion</title></head><body><p>${escapeHtml(text)}</p></body></html>`;

/** The authorize URL for a flow: PKCE S256, the state, the redirect, the resource and the scope. */
function authorizeUrl(flow: Flow, state: string): string {
  const u = new URL(flow.found.authorize);
  const challenge = b64url(createHash("sha256").update(flow.verifier).digest());
  const q = {
    response_type: "code",
    client_id: flow.client.clientId,
    redirect_uri: flow.client.redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: flow.found.resource,
    ...(flow.found.scope ? { scope: flow.found.scope } : {}),
  };
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return u.href;
}

/** The client as given or made, without fields it doesn't have. */
function clientOf(c: Client): Client {
  const client: Client = { clientId: c.clientId, redirectUri: c.redirectUri, auth: c.auth };
  if (c.clientSecret) client.clientSecret = c.clientSecret;
  return client;
}

export function createOAuth(d: OAuthDeps): OAuth {
  return new OAuthFlows(d);
}

class OAuthFlows implements OAuth {
  private readonly net: Net;
  private readonly now: () => number;
  private readonly flows = new Map<string, Flow>();
  private readonly refreshing = new Map<string, Promise<string | null>>();
  private readonly detected = new Map<string, { needs: boolean; at: number }>();
  /** Servers whose sign-in couldn't be reached once their token expired. */
  private readonly cantReach = new Set<string>();
  /** Servers already said to need signing in again. */
  private readonly said = new Set<string>();
  private readonly port: CallbackPort;

  constructor(private readonly d: OAuthDeps) {
    this.net = d.net ?? systemNet;
    this.now = d.now ?? Date.now;
    this.port = new CallbackPort(
      (q) => this.callback(q),
      () => this.flows.size === 0,
      d.ports,
    );
  }

  private say(type: EventType, id: string): void {
    this.d.store.append({ chatId: null, runId: null, origin: "daemon", type, data: { id } });
  }

  /** Sign in again, said once until you sign in. */
  private sayLost(id: string): void {
    if (this.said.has(id)) return;
    this.said.add(id);
    this.say(EV.toolNeedsSignIn, id);
  }

  private async kept(account: string): Promise<Kept | null> {
    return parseKept(await this.d.secrets.get(account));
  }

  async detect(url: string): Promise<boolean> {
    const was = this.detected.get(url);
    if (was && this.now() - was.at < DETECT_MS) return was.needs;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    const needs = await needsSignIn(this.net, u).catch(() => false);
    this.detected.set(url, { needs, at: this.now() });
    return needs;
  }

  async status(id: string, o: { probe?: boolean } = {}): Promise<SignInStatus | null> {
    const s = await this.d.resolve(id);
    if (!s) return null;
    const k = await this.kept(s.account).catch(() => null);
    if (k && !k.access) return "sign in again";
    if (k) return this.cantReach.has(id) ? "can't reach" : "signed in";
    return o.probe && (await this.detect(s.url)) ? "sign in" : null;
  }

  private async server(id: string) {
    const s = await this.d.resolve(id);
    if (!s) throw new UserError(`Unknown connection: ${id}`);
    const k = await this.kept(s.account).catch((e: unknown) => {
      throw new UserError(e instanceof KeychainError ? e.message : SAY.unreachable);
    });
    return { ...s, kept: k };
  }

  /** The client to sign in with: the one you gave, the one kept from before, or a newly registered one. */
  private async client(found: Found, kept: Kept | null, redirectUri: string, given?: { clientId?: string }) {
    if (given?.clientId !== undefined) return givenClient(given, found, redirectUri);
    if (kept && kept.issuer === found.issuer && kept.redirectUri === redirectUri) return kept;
    return register(this.net, found, redirectUri);
  }

  async signIn(id: string, given?: { clientId?: string; clientSecret?: string }): Promise<{ url: string }> {
    const s = await this.server(id);
    const server = new URL(s.url);
    const found = await discover(this.net, server, (await probe(this.net, server)) ?? {});
    const port = await this.port.open();
    if (!port) throw new UserError(NO_PORT);
    try {
      const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
      const client = clientOf(await this.client(found, s.kept, redirectUri, given));
      const state = b64url(randomBytes(32));
      const ms = this.d.stateMs ?? STATE_MS;
      const flow: Flow = {
        ...{ id, account: s.account, origin: server.origin, found, client },
        ...{ expires: this.now() + ms, verifier: b64url(randomBytes(32)) },
        timer: setTimeout(() => this.expire(state), ms),
      };
      flow.timer.unref?.();
      this.flows.set(state, flow);
      return { url: authorizeUrl(flow, state) };
    } finally {
      if (!this.flows.size) await this.port.close();
    }
  }

  /** A sign-in link ran out: forgotten, and the port closes when nothing else waits. */
  private expire(state: string): void {
    this.flows.delete(state);
    if (!this.flows.size) void this.port.close();
  }

  /** The flow this state started, once: unknown, used or expired is none. */
  private take(state: string | null): Flow | null {
    const flow = state ? this.flows.get(state) : undefined;
    if (!flow || !state) return null;
    this.flows.delete(state);
    clearTimeout(flow.timer);
    return flow.expires > this.now() ? flow : null;
  }

  /** Still the same server, at the same origin, as when the sign-in started. */
  private async same(flow: Flow): Promise<boolean> {
    const s = await this.d.resolve(flow.id);
    return !!s && s.account === flow.account && new URL(s.url).origin === flow.origin;
  }

  async callback(q: URLSearchParams): Promise<{ ok: boolean; page: string }> {
    const flow = this.take(q.get("state"));
    if (!flow || !(await this.same(flow))) return { ok: false, page: page(OLD) };
    const code = q.get("code");
    const iss = q.get("iss");
    const issOk = iss === null ? !flow.found.issParam : iss === flow.found.issuer;
    if (!code || q.has("error") || !issOk) return { ok: false, page: page(NOT_DONE) };
    const grant = {
      ...{ grant_type: "authorization_code", code, redirect_uri: flow.client.redirectUri },
      ...{ code_verifier: flow.verifier, resource: flow.found.resource },
    };
    const { found } = flow;
    const got = await tokenCall(
      this.net,
      found.token.href,
      { ...flow.client, resource: found.resource },
      grant,
    );
    if (typeof got === "string") return { ok: false, page: page(NOT_DONE) };
    const base: Kept = {
      v: 1,
      ...flow.client,
      issuer: found.issuer,
      token: found.token.href,
      resource: found.resource,
    };
    const stored = await this.d.secrets
      .set(flow.account, JSON.stringify(withTokens(base, got, this.now())))
      .then(
        () => true,
        () => false,
      );
    if (!stored) return { ok: false, page: page(NOT_DONE) };
    this.said.delete(flow.id);
    this.cantReach.delete(flow.id);
    this.say(EV.toolSignedIn, flow.id);
    return { ok: true, page: page(DONE) };
  }

  freshToken(id: string): Promise<string | null> {
    const running = this.refreshing.get(id);
    if (running) return running;
    const p = this.fresh(id)
      .catch(() => null)
      .finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, p);
    return p;
  }

  private async fresh(id: string): Promise<string | null> {
    const s = await this.d.resolve(id);
    const k = s ? await this.kept(s.account) : null;
    if (!s || !k?.access) return null;
    if (!k.expiresAt || k.expiresAt - this.now() > EARLY_MS) return k.access;
    if (!k.refresh) return this.lost(id, s.account, k);
    const grant = { grant_type: "refresh_token", refresh_token: k.refresh, resource: k.resource };
    const got = await tokenCall(this.net, k.token, k, grant);
    if (got === "dead") return this.lost(id, s.account, k);
    if (got === "unreachable") return this.unreachable(id, k);
    this.cantReach.delete(id);
    // The new token is used even if it can't be kept; its rotated refresh token is lost, so: sign in again.
    await this.d.secrets
      .set(s.account, JSON.stringify(withTokens(k, got, this.now())))
      .catch(() => this.sayLost(id));
    return got.access;
  }

  /** Couldn't ask now: the token while it lasts, then "can't reach"; the refresh token is kept for next time. */
  private unreachable(id: string, k: Kept): string | null {
    if (k.expiresAt! > this.now()) return k.access!;
    this.cantReach.add(id);
    return null;
  }

  /** The tokens are no good: forgotten (the client kept), and "Sign in again" said once. */
  private async lost(id: string, account: string, k: Kept): Promise<null> {
    await this.d.secrets.set(account, JSON.stringify(withoutTokens(k))).catch(() => {});
    this.cantReach.delete(id);
    this.sayLost(id);
    return null;
  }

  async signOut(id: string): Promise<void> {
    const s = await this.d.resolve(id);
    if (!s) throw new UserError(`Unknown connection: ${id}`);
    for (const [state, f] of this.flows) if (f.id === id) this.take(state);
    if (!this.flows.size) await this.port.close();
    await this.d.secrets.remove(s.account);
    this.said.delete(id);
    this.cantReach.delete(id);
    this.say(EV.toolSignedOut, id);
  }

  async close(): Promise<void> {
    for (const f of this.flows.values()) clearTimeout(f.timer);
    this.flows.clear();
    await this.port.close();
  }
}
