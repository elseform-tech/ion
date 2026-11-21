import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { UserError } from "../api/errors.js";

/**
 * What ion says when signing in goes wrong: fixed plain text, never a server's own words (they can hold a token or
 * a code) and never a URL with a query.
 */
export const SAY = {
  notFound: "ion couldn't find this server's sign-in",
  insecure: "This server's sign-in isn't secure (it uses http)",
  away: "This server's sign-in points to this computer or your network",
  mismatch: "This server's sign-in doesn't match it",
  noPkce: "This server's sign-in isn't safe enough (no PKCE)",
  refused: "This server refused ion's sign-in",
  unreachable: "ion couldn't reach this server's sign-in",
} as const;

type Res = { status: number; header(name: string): string | null; text: string };
/** `maxBytes`, `timeoutMs`: tighter (or looser) limits than sign-in's own, for one request. */
type Init = {
  method: string;
  headers: Record<string, string>;
  body?: string;
  maxBytes?: number;
  timeoutMs?: number;
};
export type Address = { address: string; family: number };
/** How ion reaches a server: names looked up, then each request sent to the address ion checked (pinned). */
export type Net = {
  dns(host: string): Promise<Address[]>;
  send(url: URL, init: Init, to: Address): Promise<Res>;
};
/**
 * Where sign-in requests may go: public addresses over https; with `local` (the MCP server itself is on this
 * computer) also http and loopback on this computer; with `own` (the MCP server's own URL, which you wrote) anywhere.
 */
export type Reach = { local: boolean; own?: boolean };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;

/** Addresses no sign-in request goes to: unspecified, private, CGNAT, link-local, unique-local, multicast. */
const AWAY_RANGES = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/3",
  "::/128",
  "fe80::/10",
  "fc00::/7",
  "ff00::/8",
];
const AWAY = new BlockList();
for (const range of AWAY_RANGES) {
  const [net, bits] = range.split("/") as [string, string];
  AWAY.addSubnet(net, Number(bits), net.includes(":") ? "ipv6" : "ipv4");
}
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

/** The IPv4 address inside an IPv4-mapped IPv6 one (::ffff:a.b.c.d), else the address as it is. */
const unmapped = (a: string) =>
  a.toLowerCase().startsWith("::ffff:") && isIP(a.slice(7)) === 4 ? a.slice(7) : a;

/** Whether a request may go to this address. */
function reachable(address: string, reach: Reach): boolean {
  const a = unmapped(address);
  const type = isIP(a) === 4 ? "ipv4" : "ipv6";
  if (LOOPBACK.check(a, type)) return reach.local;
  return !AWAY.check(a, type);
}

/** The URL, if ion may send a sign-in request there: https, or http on this computer for a local server. */
export function secureUrl(raw: unknown, reach: Reach): URL {
  let u: URL;
  try {
    u = new URL(String(raw));
  } catch {
    throw new UserError(SAY.notFound);
  }
  const plainOk = u.protocol === "http:" && (reach.local || reach.own) && LOCAL_HOSTS.has(u.hostname);
  if (u.protocol !== "https:" && !plainOk) throw new UserError(SAY.insecure);
  if (u.username || u.password || u.hash) throw new UserError(SAY.notFound);
  return u;
}

/** The address a request to `url` goes to: every address its name has must be one ion may reach. */
export async function vet(net: Net, url: URL, reach: Reach): Promise<Address> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  const all = family
    ? [{ address: host, family }]
    : await net.dns(host).catch(() => {
        throw new UserError(SAY.unreachable);
      });
  if (!all.length) throw new UserError(SAY.unreachable);
  if (!reach.own && !all.every((a) => reachable(a.address, reach))) throw new UserError(SAY.away);
  return all[0]!;
}

/** Sends to the checked address only; a network failure says ion couldn't reach it. */
async function send(net: Net, url: URL, init: Init, reach: Reach): Promise<Res> {
  const to = await vet(net, url, reach);
  return net.send(url, init, to).catch(() => {
    throw new UserError(SAY.unreachable);
  });
}

/**
 * GETs `url` (followed through at most 3 redirects, each to the same origin and checked again): the response, or
 * null when it isn't there (404 or any other refusal).
 */
async function getFollowing(net: Net, url: URL, reach: Reach): Promise<Res | null> {
  let at = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const r = await send(net, at, { method: "GET", headers: { accept: "application/json" } }, reach);
    if (r.status < 300 || r.status >= 400) return r.status >= 200 && r.status < 300 ? r : null;
    const next = new URL(r.header("location") ?? "", at);
    if (next.origin !== url.origin) return null;
    at = next;
  }
  return null;
}

const objectOf = (text: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** JSON metadata at `url`, or null when it isn't there or isn't a JSON object. */
export async function getJson(net: Net, url: URL, reach: Reach): Promise<Record<string, unknown> | null> {
  const r = await getFollowing(net, url, reach);
  return r ? objectOf(r.text) : null;
}

/**
 * POSTs to a server (no redirects followed): its status and JSON answer (null when it isn't JSON). A network
 * failure says ion couldn't reach it.
 */
export async function post(
  net: Net,
  url: URL,
  o: { body: string; type: string; headers?: Record<string, string>; reach: Reach },
): Promise<{ status: number; json: Record<string, unknown> | null; header(name: string): string | null }> {
  const headers = { "content-type": o.type, accept: "application/json, text/event-stream", ...o.headers };
  const r = await send(net, url, { method: "POST", headers, body: o.body }, o.reach);
  return { status: r.status, json: objectOf(r.text), header: r.header };
}

/** Reads a response, at most `max` bytes (more: the request is dropped). */
function readCapped(res: IncomingMessage, max = MAX_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.on("data", (d: Buffer) => {
      size += d.length;
      if (size > max) res.destroy(new Error("too big"));
      else chunks.push(d);
    });
    res.on("error", reject);
    res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

/** A DNS lookup for Node's http(s) that only ever answers the address ion checked. */
export const pinnedLookup =
  (to: Address): LookupFunction =>
  (_host, opts, cb) =>
    (opts as { all?: boolean }).all
      ? (cb as (e: null, a: Address[]) => void)(null, [to])
      : (cb as (e: null, a: string, f: number) => void)(null, to.address, to.family);

/** A request on Node's own http(s), connected only to the address given (the name is still used for TLS). */
const sendPinned: Net["send"] = (url, init, to) =>
  new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: init.method,
      headers: init.body ? { ...init.headers, "content-length": Buffer.byteLength(init.body) } : init.headers,
      lookup: pinnedLookup(to),
      timeout: init.timeoutMs ?? TIMEOUT_MS,
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.on("response", (res) => {
      const header = (n: string) => {
        const v = res.headers[n.toLowerCase()];
        return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
      };
      readCapped(res, init.maxBytes).then(
        (text) => resolve({ status: res.statusCode ?? 0, header, text }),
        reject,
      );
    });
    req.end(init.body);
  });

/** The computer's own DNS and network. */
export const systemNet: Net = {
  dns: async (host) =>
    (await lookup(host, { all: true })).map((a) => ({ address: a.address, family: a.family })),
  send: sendPinned,
};

export const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
export const strs = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;

/** Whether the MCP server is on this computer (then its sign-in may be too). */
export const isLocal = (server: URL) => LOCAL_HOSTS.has(server.hostname) && server.hostname !== "";
