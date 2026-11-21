import { type RegistryHit, stripControl } from "@ion/schema";
import { UserError } from "../api/errors.js";
import { type Net, vet } from "../secrets/oauth-net.js";

/**
 * The official MCP Registry (read 2026-11-21): `GET /v0/servers?search=<text>&version=latest&limit=<n>` answers
 * `{ servers: [{ server: { name, description, repository?: { url }, websiteUrl?, packages?: [{ registryType: "npm" |
 * "pypi" | "oci" | …, identifier, transport: { type: "stdio" }, environmentVariables?: [{ name, isSecret?,
 * isRequired? }] }], remotes?: [{ type: "streamable-http" | "sse", url, headers?: [{ name, isSecret? }] }] } }],
 * metadata }`. A search matches anywhere in the name, so "github" also finds every `io.github.*` server.
 */
const REGISTRY = "https://registry.modelcontextprotocol.io/v0/servers";
const TIMEOUT_MS = 5000;
const MAX_BYTES = 1024 * 1024;
const MOST = 8;
const ID = /^[\w.@/-]{1,200}$/;
const VAR = /^[A-Za-z_]\w{0,63}$/;
const HEADER = /^[\w-]{1,64}$/;
const PACKAGE = /^[\w.@/:-]{1,200}$/;

/** A GET to a public registry (never this computer or your network): its status and text, in 5 s and 1 MB. */
export async function getPublic(net: Net, url: URL): Promise<{ status: number; text: string }> {
  const to = await vet(net, url, { local: false });
  const init = {
    method: "GET",
    headers: { accept: "application/json" },
    maxBytes: MAX_BYTES,
    timeoutMs: TIMEOUT_MS,
  };
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_r, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS);
  });
  try {
    return await Promise.race([net.send(url, init, to), late]);
  } finally {
    clearTimeout(timer);
  }
}

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Raw) : {});
const list = (v: unknown): Raw[] => (Array.isArray(v) ? v.map(obj) : []);
/** Registry text, shown as data: no control characters, at most `n` characters. */
const clip = (v: unknown, n: number) => (typeof v === "string" ? stripControl(v).trim().slice(0, n) : "");
const https = (v: unknown) => {
  const t = clip(v, 300);
  return /^https:\/\/[^\s]+$/.test(t) ? t : undefined;
};

/** How the publisher runs a package: npx, uvx or docker; null for kinds ion doesn't run (mcpb, nuget…). */
function runOf(p: Raw): RegistryHit["run"][number] | null {
  const id = clip(p.identifier, 200);
  if (!PACKAGE.test(id) || obj(p.transport).type !== "stdio") return null;
  if (p.registryType === "npm") return { command: "npx", args: ["-y", id] };
  if (p.registryType === "pypi") return { command: "uvx", args: [id] };
  if (p.registryType !== "oci") return null;
  const env = list(p.environmentVariables).flatMap((e) =>
    VAR.test(clip(e.name, 64)) ? ["-e", clip(e.name, 64)] : [],
  );
  return { command: "docker", args: ["run", "-i", "--rm", ...env, id] };
}

/** One registry entry as ion shows it, or null when it gives nothing ion could run. */
function hitOf(entry: Raw): RegistryHit | null {
  const s = obj(entry.server);
  const id = clip(s.name, 200);
  if (!ID.test(id)) return null;
  const packages = list(s.packages);
  const remotes = list(s.remotes).filter((r) => r.type === "streamable-http" && https(r.url));
  const run = [
    ...packages.map(runOf).filter((r): r is NonNullable<typeof r> => r !== null),
    ...remotes.map((r) => ({ url: https(r.url)! })),
  ];
  if (!run.length) return null;
  const keys = packages
    .flatMap((p) => list(p.environmentVariables))
    .filter((e) => e.isSecret === true || e.isRequired === true)
    .map((e) => clip(e.name, 64))
    .filter((n) => VAR.test(n));
  const headers = remotes
    .flatMap((r) => list(r.headers))
    .filter((h) => h.isSecret === true)
    .map((h) => clip(h.name, 64))
    .filter((n) => HEADER.test(n));
  const source = https(obj(s.repository).url) ?? https(s.websiteUrl);
  return {
    id,
    description: clip(s.description, 300),
    ...(source ? { source } : {}),
    run: run.slice(0, 4),
    keys: [...new Set(keys)].slice(0, 10),
    headers: [...new Set(headers)].slice(0, 10),
  };
}

/** Best first: the publisher named for it (`io.github.<q>/…`), then a name that is it, then one that holds it. */
function rank(q: string, id: string): number {
  const [publisher = "", name = ""] = id.toLowerCase().split("/");
  if (publisher.endsWith(`.${q}`)) return 0;
  if ([q, `${q}-mcp`, `${q}-mcp-server`, `mcp-${q}`].includes(name)) return 1;
  return name.includes(q) ? 2 : 3;
}

async function searchOnce(net: Net, q: string): Promise<RegistryHit[]> {
  const url = new URL(REGISTRY);
  url.search = new URLSearchParams({ search: q, version: "latest", limit: "100" }).toString();
  const r = await getPublic(net, url).catch(() => null);
  if (!r) throw new UserError("ion couldn't reach the MCP Registry");
  if (r.status !== 200) throw new UserError("The MCP Registry didn't answer");
  let body: unknown;
  try {
    body = JSON.parse(r.text);
  } catch {
    throw new UserError("The MCP Registry didn't answer");
  }
  return list(obj(body).servers)
    .map(hitOf)
    .filter((h): h is RegistryHit => h !== null);
}

/**
 * The registry's servers for a name, best first: what each runs, the keys it needs, its source. Also searched as
 * "<name>-mcp", since a plain word matches hundreds of names.
 */
export async function searchRegistry(net: Net, query: string): Promise<RegistryHit[]> {
  const q = clip(query, 80).toLowerCase();
  if (!/^[\w.@/-]+$/.test(q)) throw new UserError("Search for a name");
  const both = await Promise.all([searchOnce(net, q), q.endsWith("mcp") ? [] : searchOnce(net, `${q}-mcp`)]);
  const seen = new Set<string>();
  return both
    .flat()
    .filter((h) => !seen.has(h.id) && seen.add(h.id))
    .sort((a, b) => rank(q, a.id) - rank(q, b.id))
    .slice(0, MOST);
}

/** Whether a package is published (npm or PyPI); null when ion couldn't tell. */
export async function packageFound(net: Net, kind: "npm" | "pypi", name: string): Promise<boolean | null> {
  if (!PACKAGE.test(name)) return false;
  const url =
    kind === "npm"
      ? new URL(`https://registry.npmjs.org/${name.replace("/", "%2F")}`)
      : new URL(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
  const r = await getPublic(net, url).catch(() => null);
  if (!r) return null;
  if (r.status === 404) return false;
  return r.status === 200 ? true : null;
}
