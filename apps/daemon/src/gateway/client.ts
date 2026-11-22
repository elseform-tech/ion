import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { LocalUpstream } from "./index.js";
import { openUpstream, type Upstream } from "./upstream.js";

const MAX_ANSWER = 4 * 1024 * 1024;
let ids = 0;

/** A JSON-RPC answer from a JSON body or an SSE stream: the message with this id. */
function answerOf(text: string, sse: boolean, id: number): { result?: unknown; error?: unknown } | null {
  const bodies = sse
    ? text
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
    : [text];
  for (const b of bodies) {
    try {
      const m = JSON.parse(b) as { id?: unknown; result?: unknown; error?: unknown };
      if (m.id === id) return m;
    } catch {
      // not this one
    }
  }
  return null;
}

/** One POST to a remote server through ion (its key or token added): its answer and session. */
async function post(up: Upstream, message: object, session?: string) {
  const headers = await up.headers();
  if (!headers) throw new Error("needs a sign-in");
  const body = Buffer.from(JSON.stringify(message));
  const { res } = await openUpstream(up.url, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": LATEST_PROTOCOL_VERSION,
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body,
  });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of res as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > MAX_ANSWER) throw new Error("too large");
    chunks.push(c);
  }
  return {
    status: res.statusCode ?? 0,
    text: Buffer.concat(chunks).toString("utf8"),
    sse: String(res.headers["content-type"] ?? "").startsWith("text/event-stream"),
    session: typeof res.headers["mcp-session-id"] === "string" ? res.headers["mcp-session-id"] : session,
  };
}

/**
 * Asks one of your servers one thing (ion's own question, e.g. tools/list), the way ion's gateway reaches it: a local
 * one through ion's bridge (which does the handshake), a remote one with its own handshake first.
 */
export async function askServer(
  up: Upstream | LocalUpstream,
  method: string,
  params: object = {},
): Promise<unknown> {
  const id = ++ids;
  if ("send" in up) {
    const a = (await up.send({ jsonrpc: "2.0", id, method, params })) as {
      result?: unknown;
      error?: unknown;
    } | null;
    if (!a || a.error !== undefined) throw new Error("no answer");
    return a.result;
  }
  const init = await post(up, {
    jsonrpc: "2.0",
    id: ++ids,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "ion", version: "1" },
    },
  });
  if (init.status >= 400) throw new Error(`answered ${init.status}`);
  await post(up, { jsonrpc: "2.0", method: "notifications/initialized" }, init.session);
  const r = await post(up, { jsonrpc: "2.0", id, method, params }, init.session);
  const a = answerOf(r.text, r.sse, id);
  if (!a || a.error !== undefined) throw new Error("no answer");
  return a.result;
}
