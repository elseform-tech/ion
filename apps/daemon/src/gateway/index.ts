import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import type { GateCall } from "@ion/adapter-kit";
import type { GateAnswer } from "../gate/index.js";
import type { Grants } from "../mcp/index.js";
import type { Net } from "../secrets/oauth-net.js";
import { decided, hasDuplicateKeys, idOf, type RpcId } from "./methods.js";
import { openUpstream, type Upstream } from "./upstream.js";

export { type Upstream, upstreamOf } from "./upstream.js";

/** One of your local servers, run by ion for the run (workspace/mcp-bridge): a gated message in, its answer out. */
export type LocalUpstream = { send(message: unknown): Promise<unknown> };

export type GatewayDeps = {
  grants: Grants;
  /** The run's server by this name, only while the run goes and only if it was given to the run. */
  upstream(runId: string, name: string): Upstream | LocalUpstream | null;
  /** ion's decision on a tool call, as for the run's other calls. */
  gate(runId: string, call: GateCall): Promise<GateAnswer>;
  /** An ion's turn's servers, by its turn, and ion's gate for ions (only what reads; the user, 2026-11-21). */
  ion?: {
    upstream(turnId: string, name: string): Upstream | LocalUpstream | null;
    gate(turnId: string, call: GateCall): Promise<GateAnswer>;
  };
  dns?: Net["dns"];
};

export type Gateway = {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Closes what's still open for runs that have ended (their keys are revoked). */
  closeEnded(): void;
};

const PATH = /^\/mcp\/s\/([A-Za-z0-9_-]{1,40})$/;
const KEY = /^Bearer ([0-9a-f]{64})$/;
const MAX_BODY = 4 * 1024 * 1024;
const MAX_RESPONSE = 32 * 1024 * 1024;
/** What an agent's MCP client sends that your server needs; nothing else (its Authorization is ion's key). */
const FROM_AGENT = ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
/** What your server answers that the agent's client needs. */
const TO_AGENT = ["content-type", "mcp-session-id", "cache-control"];

const text = (res: ServerResponse, status: number, body: string) =>
  void res.writeHead(status, { "content-type": "text/plain" }).end(body);
const json = (res: ServerResponse, body: unknown) =>
  void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));

/** The body, at most MAX_BODY (more: null). */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on("end", () => resolve(size > MAX_BODY ? null : Buffer.concat(chunks)));
    req.on("error", () => resolve(null));
  });
}

const parse = (b: Buffer): unknown => {
  try {
    return JSON.parse(b.toString("utf8"));
  } catch {
    return undefined;
  }
};

/** A plain error for the agent: a JSON-RPC error for a request, else a status it understands. */
function failed(res: ServerResponse, method: string, id: RpcId, message: string): void {
  if (res.headersSent) return void res.destroy();
  if (method === "POST" && id !== null)
    return json(res, { jsonrpc: "2.0", id, error: { code: -32000, message } });
  // A GET's stream that can't be opened: as a server with no stream (the agent goes on without it).
  text(res, method === "GET" ? 405 : 502, message);
}

const pick = (h: IncomingMessage["headers"], names: string[]): Record<string, string> =>
  Object.fromEntries(
    names.flatMap((n) => {
      const v = h[n];
      return typeof v === "string" ? [[n, v]] : [];
    }),
  );

/**
 * Your server's answer, streamed to the agent as it comes. A JSON answer is at most MAX_RESPONSE; an SSE stream
 * (open for as long as the session) has no total, only the idle timeout.
 */
function relay(up: { req: ClientRequest; res: IncomingMessage }, res: ServerResponse): void {
  res.writeHead(up.res.statusCode ?? 502, pick(up.res.headers, TO_AGENT));
  res.flushHeaders();
  const stream = String(up.res.headers["content-type"] ?? "").startsWith("text/event-stream");
  let size = 0;
  up.res.on("data", (c: Buffer) => {
    size += c.length;
    if (!stream && size > MAX_RESPONSE) {
      up.req.destroy();
      res.destroy();
    } else res.write(c);
  });
  up.res.on("end", () => res.end());
  up.res.on("error", () => res.destroy());
}

type Open = { key: string; req?: ClientRequest; res: ServerResponse };

type Who =
  | { key: string; runId: string; name: string; up: Upstream | LocalUpstream; ion?: true }
  | { status: number; message: string };

const isLocal = (up: Upstream | LocalUpstream): up is LocalUpstream => "send" in up;

/**
 * A local server's answer to what the agent sent: JSON (at most MAX_RESPONSE, like a remote server's), or 202 when
 * nothing is owed. It has no stream for a GET (405: the agent goes on without one), and a DELETE has no session to
 * end.
 */
async function answerLocal(
  req: IncomingMessage,
  res: ServerResponse,
  l: { up: LocalUpstream; name: string },
  m?: unknown,
) {
  if (req.method === "GET") return text(res, 405, "No stream");
  if (req.method !== "POST") return void res.writeHead(200).end();
  const answer = await l.up.send(m);
  if (answer === null) return void res.writeHead(202).end();
  const body = JSON.stringify(answer);
  if (Buffer.byteLength(body) > MAX_RESPONSE)
    return json(res, {
      jsonrpc: "2.0",
      id: idOf(m),
      error: { code: -32000, message: `${l.name}'s answer was too large` },
    });
  res.writeHead(200, { "content-type": "application/json" }).end(body);
}

/**
 * Who's calling and for which server: no browser (any Origin), a run's or an ion's turn's live key, a server given to
 * that run or turn, and a method Streamable HTTP uses.
 */
function whoFor(d: GatewayDeps, req: IncomingMessage): Who {
  if (req.headers.origin !== undefined) return { status: 403, message: "Forbidden" };
  const name = PATH.exec((req.url ?? "").split("?")[0]!)?.[1];
  const key = KEY.exec(req.headers.authorization ?? "")?.[1];
  const scope = key ? d.grants.check(key) : null;
  if (!key || !scope || (scope.kind === "ion" && !d.ion)) return { status: 401, message: "Unknown key" };
  const id = scope.kind === "run" ? scope.runId : scope.turnId;
  const find = scope.kind === "run" ? d.upstream : d.ion!.upstream;
  const up = name ? find(id, name) : null;
  if (!name || !up) return { status: 404, message: "Not found" };
  if (!["POST", "GET", "DELETE"].includes(req.method ?? ""))
    return { status: 405, message: "Use POST, GET or DELETE" };
  return { key, runId: id, name, up, ...(scope.kind === "ion" ? { ion: true as const } : {}) };
}

/** Sends one request on to your server with your key or a fresh token, and relays its answer. */
async function forward(
  d: GatewayDeps,
  open: Set<Open>,
  o: {
    req: IncomingMessage;
    res: ServerResponse;
    key: string;
    name: string;
    up: Upstream;
    body?: Buffer;
    id: RpcId;
  },
) {
  const method = o.req.method ?? "GET";
  const headers = await o.up.headers();
  if (!headers) return failed(o.res, method, o.id, `${o.name} needs you to sign in again in ion`);
  const entry: Open = { key: o.key, res: o.res };
  open.add(entry);
  o.res.on("close", () => {
    entry.req?.destroy();
    open.delete(entry);
  });
  try {
    const up = await openUpstream(o.up.url, {
      method,
      headers: { ...pick(o.req.headers, FROM_AGENT), ...headers },
      ...(o.body ? { body: o.body } : {}),
      ...(d.dns ? { dns: d.dns } : {}),
    });
    entry.req = up.req;
    const status = up.res.statusCode ?? 502;
    if (status === 401 || status === 403) {
      up.req.destroy();
      return failed(o.res, method, o.id, `${o.name} refused ion's sign-in`);
    }
    if (status >= 500) {
      up.req.destroy();
      return failed(o.res, method, o.id, `${o.name} had a problem (${status})`);
    }
    relay(up, o.res);
  } catch {
    failed(o.res, method, o.id, `ion couldn't reach ${o.name}`);
  }
}

/**
 * ion's gateway to your MCP servers (remote ones, and local ones ion runs for the run): `/mcp/s/<name>` (Streamable HTTP), for a run's agent holding its live
 * key, and only for the servers given to that run. ion adds your keys or a fresh token, decides every tools/call
 * first, and passes the rest (sessions, SSE) through. Your server's own words never reach the agent as an error:
 * one that can't be reached or fails is a plain MCP error, and the run goes on.
 */
export function createGateway(d: GatewayDeps): Gateway {
  const open = new Set<Open>();

  return {
    async handle(req, res) {
      const who = whoFor(d, req);
      if ("status" in who) return text(res, who.status, who.message);
      const { key, name, up, runId } = who;
      if (req.method !== "POST")
        return isLocal(up)
          ? answerLocal(req, res, { up, name })
          : forward(d, open, { req, res, key, name, up, id: null });
      const body = await readBody(req);
      if (!body) return text(res, 413, "Too large");
      const parsed = parse(body);
      if (parsed === undefined)
        return json(res, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      if (hasDuplicateKeys(body.toString("utf8")))
        return json(res, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "ion couldn't read this request" },
        });
      // Streamable HTTP (2025-06-18) has no batches: one message per request, so each is decided alone.
      if (Array.isArray(parsed))
        return json(res, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "ion takes one message at a time" },
        });
      const gate = who.ion && d.ion ? d.ion.gate : d.gate;
      const refused = await decided((call) => gate(runId, call), name, parsed);
      if (refused) return json(res, refused);
      if (isLocal(up)) return answerLocal(req, res, { up, name }, parsed);
      // Exactly what was decided goes on: the message as ion read it, written out again.
      const sent = Buffer.from(JSON.stringify(parsed));
      return forward(d, open, { req, res, key, name, up, body: sent, id: idOf(parsed) });
    },
    closeEnded() {
      for (const o of open)
        if (!d.grants.check(o.key)) {
          o.req?.destroy();
          o.res.destroy();
          open.delete(o);
        }
    },
  };
}
