import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@ion/client";
import { EV, type NewEvent } from "@ion/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startServer } from "../api/server.js";
import { memorySecrets, oauthAccount, type Secrets } from "./index.js";
import { createOAuth, type OAuth, type OAuthDeps } from "./oauth.js";
import type { Net } from "./oauth-net.js";

// Plan 18, Task 2 (the user, 2026-11-20: "we have to consider mcp that might require oauth, api-key or some kind of
// login"): ion signs in to remote MCP servers the standard way, against a fake authorization server on 127.0.0.1.

type FakeOpts = {
  /** The origin the fake's links name (default: its own, on 127.0.0.1). */
  pub?: string;
  noRegistration?: boolean;
  /** The authorization server the protected-resource metadata names (default: this fake's /as). */
  authServer?: string;
  tokenEndpoint?: string;
  issuer?: string;
  /** Added to the issuer the metadata names (a trailing slash isn't the same issuer). */
  issuerSuffix?: string;
  /** null: no expires_in. */
  expiresIn?: number | null;
  /** How a refresh is answered. */
  refresh?: "ok" | "dead" | "429" | "html";
  /** Where /.well-known/oauth-protected-resource/mcp redirects to, if anywhere. */
  prmRedirect?: string;
  /** The resource_metadata the 401 names. */
  hint?: string;
  /** The protected-resource metadata's `resource`. */
  resource?: string;
  /** code_challenge_methods_supported; null: left out. */
  pkce?: string[] | null;
  /** The `iss` the authorization server sends back (and says it does). */
  iss?: string;
};

type Seen = { method: string; path: string; body: string; auth?: string };

const b64url = (b: Buffer) => b.toString("base64url");
const readBody = (req: IncomingMessage) =>
  new Promise<string>((r) => {
    let s = "";
    req.on("data", (d: Buffer) => (s += d.toString("utf8")));
    req.on("end", () => r(s));
  });
const json = (res: ServerResponse, code: number, v: unknown) =>
  res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(v));

type Route = (req: IncomingMessage, res: ServerResponse, body: string, u: URL) => void;

/** The fake authorization server's metadata. */
const metaOf = (o: FakeOpts, pub: string) => ({
  issuer: o.issuer ?? `${pub}/as${o.issuerSuffix ?? ""}`,
  authorization_endpoint: `${pub}/as/authorize`,
  token_endpoint: o.tokenEndpoint ?? `${pub}/as/token`,
  ...(o.noRegistration ? {} : { registration_endpoint: `${pub}/as/register` }),
  ...(o.pkce === null ? {} : { code_challenge_methods_supported: o.pkce ?? ["S256"] }),
  ...(o.iss ? { authorization_response_iss_parameter_supported: true } : {}),
});

function refreshAnswer(o: FakeOpts, res: ServerResponse, n: number) {
  if (o.refresh === "dead")
    return json(res, 400, { error: "invalid_grant", error_description: "RT-1 is dead" });
  if (o.refresh === "429") return json(res, 429, { error: "slow_down" });
  if (o.refresh === "html")
    return res.writeHead(200, { "content-type": "text/html" }).end("<html>wifi</html>");
  json(res, 200, { access_token: `AT-${n + 1}`, token_type: "Bearer", expires_in: 3600 });
}

/** A protected MCP endpoint and its authorization server, on one port. */
async function fakeServer(o: FakeOpts = {}) {
  const seen: Seen[] = [];
  const challenges = new Map<string, string>();
  let refreshes = 0;
  let base = "";
  const pub = () => o.pub ?? base;
  const token = (res: ServerResponse, p: URLSearchParams) => {
    if (p.get("grant_type") === "refresh_token") return refreshAnswer(o, res, ++refreshes);
    const want = challenges.get(p.get("code") ?? "");
    const got = b64url(
      createHash("sha256")
        .update(p.get("code_verifier") ?? "")
        .digest(),
    );
    if (!want || want !== got) return json(res, 400, { error: "invalid_grant" });
    if (p.get("resource") !== `${pub()}/mcp`) return json(res, 400, { error: "invalid_target" });
    const expires = o.expiresIn === null ? {} : { expires_in: o.expiresIn ?? 3600 };
    json(res, 200, { access_token: "AT-1", refresh_token: "RT-1", token_type: "Bearer", ...expires });
  };
  const routes: Record<string, Route> = {
    "/mcp": (req, res) => {
      if (req.headers.authorization?.startsWith("Bearer AT-"))
        return json(res, 200, { jsonrpc: "2.0", id: 1 });
      const hint = o.hint ?? `${pub()}/.well-known/oauth-protected-resource/mcp`;
      res
        .writeHead(401, { "www-authenticate": `Bearer resource_metadata="${hint}", scope="read write"` })
        .end();
    },
    "/.well-known/oauth-protected-resource/mcp": (_req, res) => {
      if (o.prmRedirect) return res.writeHead(302, { location: o.prmRedirect }).end();
      json(res, 200, {
        resource: o.resource ?? `${pub()}/mcp`,
        authorization_servers: [o.authServer ?? `${pub()}/as`],
      });
    },
    "/.well-known/oauth-authorization-server/as": (_req, res) => json(res, 200, metaOf(o, pub())),
    "/as/register": (_req, res, body) => {
      const r = JSON.parse(body) as { redirect_uris: string[] };
      json(res, 201, { client_id: "c1", redirect_uris: r.redirect_uris });
    },
    "/as/authorize": (_req, res, _body, u) => {
      const code = `code-${challenges.size + 1}`;
      challenges.set(code, u.searchParams.get("code_challenge") ?? "");
      const back = new URL(u.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", u.searchParams.get("state") ?? "");
      if (o.iss) back.searchParams.set("iss", o.iss);
      res.writeHead(302, { location: back.href }).end();
    },
    "/as/token": (_req, res, body) => token(res, new URLSearchParams(body)),
  };
  const srv: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", base);
    void readBody(req).then((body) => {
      seen.push({ method: req.method ?? "", path: u.pathname, body, ...auth(req) });
      const route = routes[u.pathname];
      if (route) route(req, res, body, u);
      else res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const addr = srv.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  servers.push(srv);
  return { base, url: `${pub()}/mcp`, seen, refreshes: () => refreshes };
}

const auth = (req: IncomingMessage) => (req.headers.authorization ? { auth: req.headers.authorization } : {});

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const o of opened.splice(0)) await o.close();
  vi.restoreAllMocks();
});

/** Two free ports on 127.0.0.1 for the callback (tests don't take ion's own). */
async function freePorts(n: number): Promise<number[]> {
  const got: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const a = s.address();
    got.push(typeof a === "object" && a ? a.port : 0);
    await new Promise<void>((r) => s.close(() => r()));
  }
  return got;
}

const CALLBACK = /^http:\/\/127\.0\.0\.1:(\d+)\/oauth\/callback$/;
const opened: { close(): Promise<void> }[] = [];

/** OAuth for one server named `linear` at `url`, with tokens kept in memory and events collected. */
async function oauthFor(url: string, o: Partial<OAuthDeps> & { serverUrl?: () => string } = {}) {
  const secrets = (o.secrets as ReturnType<typeof memorySecrets> | undefined) ?? memorySecrets();
  const events: NewEvent[] = [];
  const account = oauthAccount("linear", url);
  const oauth: OAuth = createOAuth({
    secrets,
    store: { append: (e: NewEvent) => void events.push(e) },
    resolve: async (id) => (id === "linear" ? { url: o.serverUrl?.() ?? url, account } : null),
    ports: o.ports ?? (await freePorts(2)),
    ...o,
  });
  opened.push(oauth);
  return { oauth, secrets: secrets as ReturnType<typeof memorySecrets>, events, account };
}

/** Follows the sign-in URL at the fake (it "consents" at once) to the callback it sends the browser to. */
async function consent(url: string, via = (u: string) => u): Promise<URLSearchParams> {
  const r = await fetch(via(url), { redirect: "manual" });
  const back = new URL(r.headers.get("location")!);
  expect(back.origin + back.pathname).toMatch(CALLBACK);
  return back.searchParams;
}

async function signedIn(o: FakeOpts = {}, deps: Partial<OAuthDeps> = {}) {
  const fake = await fakeServer(o);
  const t = await oauthFor(fake.url, deps);
  const { url } = await t.oauth.signIn("linear");
  const page = await t.oauth.callback(await consent(url));
  return { fake, ...t, page };
}

const OLD = { ok: false, page: expect.stringContaining("That sign-in link is old. Try again from ion.") };

describe("signing in to a remote server", () => {
  it("discovers from a 401's WWW-Authenticate, registers, and signs in with PKCE", async () => {
    const fake = await fakeServer();
    const { oauth, secrets, events, account } = await oauthFor(fake.url);
    expect(await oauth.detect(fake.url)).toBe(true);
    expect(secrets.all().size).toBe(0);
    const { url } = await oauth.signIn("linear");
    expect(secrets.all().size).toBe(0); // nothing stored until signed in
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(`${fake.base}/as/authorize`);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "c1",
      code_challenge_method: "S256",
      resource: fake.url,
      scope: "read write",
    });
    expect(u.searchParams.get("redirect_uri")).toMatch(CALLBACK);
    expect(u.searchParams.get("state")).toMatch(/^[\w-]{32,}$/);
    expect(u.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    const register = fake.seen.find((s) => s.path === "/as/register");
    expect(JSON.parse(register!.body)).toMatchObject({
      redirect_uris: [u.searchParams.get("redirect_uri")],
      token_endpoint_auth_method: "none",
    });
    const page = await oauth.callback(await consent(url));
    expect(page).toEqual({ ok: true, page: expect.stringContaining("Signed in. You can close this tab.") });
    expect(page.page).not.toMatch(/<script/i);
    expect(secrets.all().get(account)).toContain("AT-1");
    expect(await oauth.freshToken("linear")).toBe("AT-1");
    expect(await oauth.status("linear")).toBe("signed in");
    expect(events).toEqual([expect.objectContaining({ type: EV.toolSignedIn, data: { id: "linear" } })]);
  });

  it("a server that answers without a sign-in doesn't need one", async () => {
    const fake = await fakeServer();
    const { oauth } = await oauthFor(fake.url);
    expect(await oauth.detect(`${fake.base}/nothing-here`)).toBe(false);
  });

  // Review Focus 3.
  it("refuses a callback with the wrong state", async () => {
    const fake = await fakeServer();
    const { oauth, secrets, events } = await oauthFor(fake.url);
    const back = await consent((await oauth.signIn("linear")).url);
    const wrong = new URLSearchParams(back);
    wrong.set("state", "not-the-state-ion-made-at-all-xxxxxxxx");
    expect(await oauth.callback(wrong)).toEqual(OLD);
    expect(await oauth.callback(new URLSearchParams())).toEqual(OLD);
    expect(secrets.all().size).toBe(0);
    expect((await oauth.callback(back)).ok).toBe(true);
    // Single use: the same link again changes nothing.
    expect(await oauth.callback(back)).toEqual(OLD);
    expect(events).toHaveLength(1);
  });

  // Review Focus 3.
  it("refuses a sign-in link older than 10 minutes", async () => {
    const fake = await fakeServer();
    let now = Date.now();
    const { oauth, secrets } = await oauthFor(fake.url, { now: () => now });
    const back = await consent((await oauth.signIn("linear")).url);
    now += 10 * 60_000 + 1;
    expect(await oauth.callback(back)).toEqual(OLD);
    expect(secrets.all().size).toBe(0);
  });

  // Task review, 2026-11-20 (M7): the callback is for the server as it was when the sign-in started.
  it("refuses a callback once the server points somewhere else", async () => {
    const fake = await fakeServer();
    let at = fake.url;
    const { oauth, secrets } = await oauthFor(fake.url, { serverUrl: () => at });
    const back = await consent((await oauth.signIn("linear")).url);
    at = "https://elsewhere.example/mcp";
    expect(await oauth.callback(back)).toEqual(OLD);
    expect(secrets.all().size).toBe(0);
  });

  // Task review, 2026-11-20 (M7): an `iss` that isn't the issuer (RFC 9207) finishes nothing.
  it("refuses a callback from another issuer", async () => {
    const fake = await fakeServer({ iss: "https://mix-up.example" });
    const { oauth, secrets } = await oauthFor(fake.url);
    const r = await oauth.callback(await consent((await oauth.signIn("linear")).url));
    expect(r).toEqual({ ok: false, page: expect.stringContaining("Sign-in didn't finish.") });
    expect(secrets.all().size).toBe(0);
    const right = await fakeServer({ iss: "" });
    const t = await oauthFor(right.url);
    const back = await consent((await t.oauth.signIn("linear")).url);
    back.set("iss", `${right.base}/as`);
    expect((await t.oauth.callback(back)).ok).toBe(true);
  });

  // Review Focus 3.
  it("refuses an http authorization server that isn't localhost", async () => {
    const plain = await fakeServer({ authServer: "http://auth.example.com" });
    await expect((await oauthFor(plain.url)).oauth.signIn("linear")).rejects.toThrow(
      "This server's sign-in isn't secure (it uses http)",
    );
    const token = await fakeServer({ tokenEndpoint: "http://auth.example.com/token" });
    await expect((await oauthFor(token.url)).oauth.signIn("linear")).rejects.toThrow(
      "This server's sign-in isn't secure (it uses http)",
    );
    expect(token.seen.some((s) => s.path === "/as/register")).toBe(false);
  });

  // Review Focus 3; Task review, 2026-11-20 (M5, M6): exact issuer, and the metadata is for this server.
  it("refuses metadata whose issuer or resource doesn't match, and a redirect to another origin", async () => {
    const issuer = await fakeServer({ issuer: "https://someone-else.example" });
    const mismatch = "This server's sign-in doesn't match it";
    await expect((await oauthFor(issuer.url)).oauth.signIn("linear")).rejects.toThrow(mismatch);
    const s = await fakeServer({ issuerSuffix: "/" });
    await expect((await oauthFor(s.url)).oauth.signIn("linear")).rejects.toThrow(mismatch);
    const other = await fakeServer({ resource: "http://127.0.0.1:1/other" });
    await expect((await oauthFor(other.url)).oauth.signIn("linear")).rejects.toThrow(mismatch);
    const moved = await fakeServer({ prmRedirect: "https://elsewhere.example/prm" });
    await expect((await oauthFor(moved.url)).oauth.signIn("linear")).rejects.toThrow(
      "ion couldn't find this server's sign-in",
    );
  });

  // Task review, 2026-11-20 (I2, M7): PKCE with S256 is required (MCP 2025-11-25).
  it("refuses a server that doesn't say it takes PKCE S256", async () => {
    const none = await fakeServer({ pkce: null });
    const noPkce = "This server's sign-in isn't safe enough (no PKCE)";
    await expect((await oauthFor(none.url)).oauth.signIn("linear")).rejects.toThrow(noPkce);
    const plain = await fakeServer({ pkce: ["plain"] });
    await expect((await oauthFor(plain.url)).oauth.signIn("linear")).rejects.toThrow(noPkce);
  });

  it("no dynamic registration: asks for a client ID, with the redirect URI to register", async () => {
    const fake = await fakeServer({ noRegistration: true });
    const [p] = await freePorts(1);
    const { oauth, secrets, account } = await oauthFor(fake.url, { ports: [p!] });
    await expect(oauth.signIn("linear")).rejects.toThrow(
      `This server needs a client ID. Register ion with http://127.0.0.1:${p}/oauth/callback`,
    );
    const { url } = await oauth.signIn("linear", { clientId: "mine", clientSecret: "shh-secret" });
    expect(new URL(url).searchParams.get("client_id")).toBe("mine");
    expect(url).not.toContain("shh-secret");
    expect((await oauth.callback(await consent(url))).ok).toBe(true);
    const tokenCall = fake.seen.find((s) => s.path === "/as/token");
    expect(tokenCall?.auth).toBe(`Basic ${Buffer.from("mine:shh-secret").toString("base64")}`);
    expect(secrets.all().get(account)).toContain("shh-secret");
    await oauth.signOut("linear");
    expect(secrets.all().size).toBe(0);
  });
});

describe("refreshing", () => {
  it("refreshes a token before it expires, one refresh at a time", async () => {
    const { oauth, fake } = await signedIn({ expiresIn: 30 });
    const got = await Promise.all([oauth.freshToken("linear"), oauth.freshToken("linear")]);
    expect(got).toEqual(["AT-2", "AT-2"]);
    expect(fake.refreshes()).toBe(1);
    const refresh = new URLSearchParams(fake.seen.filter((s) => s.path === "/as/token").at(-1)!.body);
    expect(Object.fromEntries(refresh)).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "RT-1",
      client_id: "c1",
      resource: fake.url,
    });
    // Good for an hour now: no other refresh.
    expect(await oauth.freshToken("linear")).toBe("AT-2");
    expect(fake.refreshes()).toBe(1);
  });

  // Task review, 2026-11-20 (M2): no expires_in with a refresh token: taken as an hour.
  it("a token with no expiry but a refresh token is refreshed after an hour", async () => {
    let now = Date.now();
    const { oauth, fake } = await signedIn({ expiresIn: null }, { now: () => now });
    expect(await oauth.freshToken("linear")).toBe("AT-1");
    now += 3550_000;
    expect(await oauth.freshToken("linear")).toBe("AT-2");
    expect(fake.refreshes()).toBe(1);
  });

  // Review Focus 1.
  it("a failed refresh marks it Sign in again", async () => {
    const { oauth, events, secrets, account } = await signedIn({ expiresIn: 30, refresh: "dead" });
    expect(await oauth.freshToken("linear")).toBeNull();
    expect(await oauth.status("linear")).toBe("sign in again");
    expect(events.map((e) => e.type)).toEqual([EV.toolSignedIn, EV.toolNeedsSignIn]);
    expect(events[1]?.data).toEqual({ id: "linear" });
    expect(secrets.all().get(account)).not.toContain("RT-1");
    // Said once.
    expect(await oauth.freshToken("linear")).toBeNull();
    expect(events).toHaveLength(2);
  });

  // Task review, 2026-11-20 (I1, M3): bad Wi-Fi isn't a dead sign-in.
  it.each(["429", "html"] as const)(
    "a refresh answered %s keeps the tokens, then says can't reach",
    async (r) => {
      let now = Date.now();
      const { oauth, events, secrets, account } = await signedIn(
        { expiresIn: 30, refresh: r },
        { now: () => now },
      );
      expect(await oauth.freshToken("linear")).toBe("AT-1");
      expect(await oauth.status("linear")).toBe("signed in");
      now += 31_000;
      expect(await oauth.freshToken("linear")).toBeNull();
      expect(await oauth.status("linear")).toBe("can't reach");
      expect(secrets.all().get(account)).toContain("RT-1");
      expect(events.map((e) => e.type)).toEqual([EV.toolSignedIn]);
    },
  );

  // Task review, 2026-11-20 (M1): the new token is used even if it couldn't be kept.
  it("a refreshed token that can't be kept is still used, and Sign in again is said once", async () => {
    const inner = memorySecrets();
    let broken = false;
    const secrets: Secrets = {
      get: inner.get,
      remove: inner.remove,
      set: async (a, v) => {
        if (broken) throw new Error("disk full");
        await inner.set(a, v);
      },
    };
    const { oauth, events } = await signedIn({ expiresIn: 30 }, { secrets });
    broken = true;
    expect(await oauth.freshToken("linear")).toBe("AT-2");
    expect(events.map((e) => e.type)).toEqual([EV.toolSignedIn, EV.toolNeedsSignIn]);
  });
});

/** A public address (built up, so it reads as what it is: an address on the internet, not a setting). */
const PUBLIC = [93, 184, 216, 34].join(".");

/** DNS for the fake's public names; an IP is itself. */
const dnsOf =
  (names: Record<string, string>): Net["dns"] =>
  async (host) => {
    const address = names[host] ?? (/^[\d.]+$/.test(host) ? host : undefined);
    if (!address) throw new Error("ENOTFOUND");
    return [{ address, family: 4 }];
  };

/** Sends each request to the fake (no TLS, no network), and records where ion pinned it. */
function sendTo(base: string, pinned: string[]): Net["send"] {
  return async (url, init, to) => {
    pinned.push(`${url.hostname}=${to.address}`);
    const r = await fetch(`${base}${url.pathname}${url.search}`, { ...init, redirect: "manual" });
    const text = await r.text();
    return { status: r.status, header: (n: string) => r.headers.get(n), text };
  };
}

// Task review, 2026-11-20 (I3, automated review): a remote server can't send ion's requests to this computer or
// your network.
describe("no requests to your own machine", () => {
  async function remote(o: FakeOpts, names: Record<string, string> = {}) {
    const fake = await fakeServer({ pub: "https://mcp.test", ...o });
    const pinned: string[] = [];
    const net: Net = {
      dns: dnsOf({ "mcp.test": PUBLIC, ...names }),
      send: sendTo(fake.base, pinned),
    };
    return { fake, pinned, ...(await oauthFor(fake.url, { net })) };
  }

  it("signs in to a public server, each request pinned to the address ion checked", async () => {
    const { oauth, fake, pinned } = await remote({});
    const { url } = await oauth.signIn("linear");
    const back = await consent(url, (u) => u.replace("https://mcp.test", fake.base));
    expect((await oauth.callback(back)).ok).toBe(true);
    expect(new Set(pinned)).toEqual(new Set([`mcp.test=${PUBLIC}`]));
  });

  const away = "This server's sign-in points to this computer or your network";
  it("refuses a 401 that names http://127.0.0.1", async () => {
    const { oauth, fake } = await remote({ hint: "http://127.0.0.1:9/x" });
    await expect(oauth.signIn("linear")).rejects.toThrow("This server's sign-in isn't secure (it uses http)");
    expect(fake.seen.some((s) => s.path === "/x")).toBe(false);
  });

  it("refuses a token endpoint on 10.0.0.1", async () => {
    const { oauth, fake } = await remote({ tokenEndpoint: "https://10.0.0.1/token" });
    await expect(oauth.signIn("linear")).rejects.toThrow(away);
    expect(fake.seen.some((s) => s.path === "/as/register")).toBe(false);
  });

  it("refuses a name that resolves to 127.0.0.1", async () => {
    const { oauth } = await remote({ authServer: "https://evil.test/as" }, { "evil.test": "127.0.0.1" });
    await expect(oauth.signIn("linear")).rejects.toThrow(away);
  });
});

// Task review, 2026-11-20 (I4): the browser comes back to a fixed port, open only while a sign-in waits.
describe("the callback's own port", () => {
  const refused = async (port: number) =>
    fetch(`http://127.0.0.1:${port}/oauth/callback`).then(
      () => false,
      () => true,
    );
  /** Closed within a second (it closes once the page is sent). */
  const closes = async (port: number) => {
    for (let i = 0; i < 20; i++) {
      if (await refused(port)) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };

  it("opens the first free port while a sign-in waits, and closes after it", async () => {
    const fake = await fakeServer();
    const [busy, free] = await freePorts(2);
    const holder = createServer();
    await new Promise<void>((r) => holder.listen(busy, "127.0.0.1", r));
    servers.push(holder);
    const { oauth } = await oauthFor(fake.url, { ports: [busy!, free!] });
    expect(await refused(free!)).toBe(true);
    const { url } = await oauth.signIn("linear");
    expect(new URL(url).searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${free}/oauth/callback`);
    const back = await fetch(url, { redirect: "manual" }).then((r) => r.headers.get("location")!);
    const page = await fetch(back);
    expect(page.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await page.text()).toContain("Signed in. You can close this tab.");
    expect(await closes(free!)).toBe(true);
  });

  it("closes when the sign-in link expires", async () => {
    const fake = await fakeServer();
    const [p] = await freePorts(1);
    const { oauth } = await oauthFor(fake.url, { ports: [p!], stateMs: 50 });
    await oauth.signIn("linear");
    expect(await refused(p!)).toBe(false);
    expect(await closes(p!)).toBe(true);
  });

  it("ion's own ports are 47291, then 47292–47299", async () => {
    const { CALLBACK_PORTS } = await import("./oauth-callback.js");
    expect(CALLBACK_PORTS).toEqual([47291, 47292, 47293, 47294, 47295, 47296, 47297, 47298, 47299]);
  });
});

/** Every file under `dir`, as text. */
const allText = (dir: string): string =>
  readdirSync(dir, { withFileTypes: true })
    .map((d) => (d.isDirectory() ? allText(join(dir, d.name)) : readFileSync(join(dir, d.name), "latin1")))
    .join("\n");

describe("signing in through the daemon", () => {
  // Review Focus 2.
  it("tokens never in events or logs", async () => {
    const fake = await fakeServer({ expiresIn: 30, refresh: "dead" });
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const home = mkdtempSync(join(tmpdir(), "ion-home-"));
    writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: { linear: { url: fake.url } } }), {
      mode: 0o600,
    });
    const secrets = memorySecrets();
    const srv = await startServer({
      dataDir: join(home, "data"),
      configFile: join(home, "config.toml"),
      secrets,
    });
    const client = await connect({ port: srv.port, token: srv.token });
    try {
      await client.call("tools.setOn", { kind: "mcp", id: "linear", on: true });
      expect((await client.call("tools.list", {})).mcp[0]).toMatchObject({
        auth: "oauth",
        signedIn: false,
        needs: "sign in",
      });
      const { url } = await client.call("tools.signIn", { id: "linear" });
      const back = await fetch(url, { redirect: "manual" }).then((r) => r.headers.get("location")!);
      expect(back).toMatch(/^http:\/\/127\.0\.0\.1:4729\d\/oauth\/callback\?/);
      expect(await fetch(back).then((r) => r.text())).toContain("Signed in. You can close this tab.");
      const info = await client.call("tools.list", {});
      expect(info.mcp[0]).toMatchObject({ auth: "oauth", signedIn: true });
      // The refresh fails (its error names the refresh token): Sign in again, said plainly.
      expect(await srv.oauth.freshToken("linear")).toBeNull();
      const again = await client.call("tools.list", {});
      expect(again.mcp[0]).toMatchObject({ signedIn: false, needs: "sign in again" });
      for (const text of [JSON.stringify(info), JSON.stringify(again)]) expect(text).not.toMatch(/AT-1|RT-1/);
      // Tokens are in the vault, never the keychain (it holds only the vault's key).
      expect([...secrets.all().keys()]).toEqual(["vault-key"]);
      await client.call("tools.signOut", { id: "linear" });
      expect(await srv.oauth.status("linear")).toBeNull();
    } finally {
      client.close();
      await srv.close();
    }
    expect(allText(home)).not.toMatch(/AT-1|RT-1|code_verifier/);
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toMatch(/AT-1|RT-1/);
  });
});
