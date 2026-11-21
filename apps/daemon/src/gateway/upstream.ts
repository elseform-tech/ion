import { type ClientRequest, type IncomingMessage, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { McpSpec } from "@ion/adapter-kit";
import { isLocal, type Net, pinnedLookup, secureUrl, systemNet, vet } from "../secrets/oauth-net.js";

/** One of your remote servers as a run reaches it through ion: its URL and the headers ion adds to each request. */
export type Upstream = {
  url: string;
  /** Your key headers, or Authorization with a token fresh for this request; null: it needs a sign-in again. */
  headers(): Promise<Record<string, string> | null>;
};

/**
 * A remote server given to a run, filled in at its start. One you signed in to asks for a fresh token on every
 * request (refreshed when it's about to expire), so a run longer than a token's life goes on.
 */
export function upstreamOf(
  spec: McpSpec & { transport: "http" },
  fresh?: () => Promise<string | null>,
): Upstream {
  return {
    url: spec.url,
    async headers() {
      if (!fresh) return { ...spec.headers };
      const token = await fresh().catch(() => null);
      return token ? { ...spec.headers, Authorization: `Bearer ${token}` } : null;
    },
  };
}

/**
 * No answer, and nothing sent or received, for this long: the request is dropped. An SSE stream your server keeps
 * quiet that long closes too; agents' MCP clients reconnect (GET again, with Last-Event-ID) when it does.
 */
const IDLE_MS = 5 * 60_000;

/**
 * Opens one request to your server: its URL checked (https, or http on this computer), its name looked up and the
 * request sent only to an address ion may reach (public ones; this computer only when the server's own URL is
 * local). Resolves with the response as it starts (the body is streamed by the caller).
 */
export async function openUpstream(
  url: string,
  o: { method: string; headers: Record<string, string>; body?: Buffer; dns?: Net["dns"] },
): Promise<{ req: ClientRequest; res: IncomingMessage }> {
  const u = new URL(url);
  const reach = { local: isLocal(u) };
  secureUrl(u.href, reach);
  const to = await vet({ ...systemNet, ...(o.dns ? { dns: o.dns } : {}) }, u, reach);
  return new Promise((resolve, reject) => {
    const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(u, {
      method: o.method,
      headers: o.body ? { ...o.headers, "content-length": o.body.length } : o.headers,
      lookup: pinnedLookup(to),
      timeout: IDLE_MS,
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.on("response", (res) => resolve({ req, res }));
    req.end(o.body);
  });
}
