import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { GateCall } from "@ion/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGrants, type Grants } from "../mcp/index.js";
import { createGateway, type Upstream, upstreamOf } from "./index.js";

// The user, 2026-11-20 ("In Plan 18 now", asked for ion as the gateway): agents connect only to ion, which adds your
// keys or tokens, gates every tool call with its real name and input, and passes the rest through as is.

type Seen = {
  method: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown> | null;
  raw: string;
};

/** A fake remote MCP server on 127.0.0.1: answers initialize with a session, tools/call with what it saw. */
function fakeUpstream(): { server: Server; seen: Seen[]; url: () => string } {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
      seen.push({ method: req.method ?? "", headers: req.headers, body, raw: text });
      answer(req, res, body);
    });
  });
  server.listen(0, "127.0.0.1");
  return { server, seen, url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp` };
}

function answer(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown> | null): void {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "sess-1" });
    res.end('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/ping"}\n\n');
    return;
  }
  if (req.method === "DELETE") return void res.writeHead(200).end();
  if (!body?.id) return void res.writeHead(202).end();
  const params = (body.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
  if (body.method === "tools/call" && params.name === "boom") return void res.writeHead(500).end("oops");
  const result =
    body.method === "tools/call"
      ? {
          content: [
            {
              type: "text",
              text: JSON.stringify({ args: params.arguments, auth: req.headers.authorization }),
            },
          ],
        }
      : { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
  const msg = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
  if (params.name === "stream") {
    res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "sess-1" });
    res.write(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\n`,
    );
    res.end(`event: message\ndata: ${msg}\n\n`);
    return;
  }
  res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" }).end(msg);
}

let up: ReturnType<typeof fakeUpstream>;
let ion: Server;
let grants: Grants;
let key: string;
let gated: GateCall[];
let decision: { decision: "allow" | "deny"; reason?: string };
let upstreams: Record<string, Upstream>;
const scope = { kind: "run" as const, projectId: "p", chatId: "c1", runId: "r1" };

beforeEach(async () => {
  up = fakeUpstream();
  await new Promise((r) => up.server.once("listening", r));
  grants = createGrants();
  key = grants.create(scope);
  gated = [];
  decision = { decision: "allow" };
  upstreams = {
    docs: upstreamOf({
      name: "docs",
      transport: "http",
      url: up.url(),
      headers: { "X-Api-Key": "key-secret-1" },
    }),
  };
  const gateway = createGateway({
    grants,
    upstream: (runId, name) => (runId === "r1" ? (upstreams[name] ?? null) : null),
    gate: async (_runId, call) => {
      gated.push(call);
      return decision;
    },
  });
  ion = createServer((req, res) => void gateway.handle(req, res));
  await new Promise<void>((r) => ion.listen(0, "127.0.0.1", r));
});

afterEach(() => {
  up.server.close();
  ion.close();
});

const at = (name: string) => `http://127.0.0.1:${(ion.address() as AddressInfo).port}/mcp/s/${name}`;
const rpc = (method: string, params: object = {}, id = 1) => ({ jsonrpc: "2.0", id, method, params });

async function post(name: string, body: object, headers: Record<string, string> = {}) {
  return fetch(at(name), {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
const postRaw = (name: string, body: string) =>
  fetch(at(name), {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body,
  });
const callTool = (name: string, args: object) => rpc("tools/call", { name, arguments: args });

describe("ion's gateway to your remote servers", () => {
  it("a tools/call reaches your server with the key added and is gated with its real name and input", async () => {
    const r = await post("docs", callTool("echo", { message: "hi" }));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { result: { content: { text: string }[] } };
    expect(JSON.parse(body.result.content[0]!.text)).toEqual({ args: { message: "hi" } });
    expect(gated).toEqual([
      expect.objectContaining({ kind: "mcp", mcpServer: "docs", toolName: "echo", input: { message: "hi" } }),
    ]);
    const sent = up.seen.at(-1)!;
    expect(sent.headers["x-api-key"]).toBe("key-secret-1");
    // The run's key is ion's, never sent on to your server.
    expect(JSON.stringify(sent.headers)).not.toContain(key);
  });

  it("adds a fresh token to each request, so one that expires mid-run is refreshed", async () => {
    const tokens = ["tok-early", "tok-refreshed"];
    const fresh = vi.fn(async () => tokens.shift() ?? null);
    upstreams.docs = upstreamOf(
      { name: "docs", transport: "http", url: up.url(), headers: { Authorization: "Bearer tok-at-start" } },
      fresh,
    );
    await post("docs", callTool("echo", {}));
    await post("docs", callTool("echo", {}));
    expect(up.seen.map((s) => s.headers.authorization)).toEqual(["Bearer tok-early", "Bearer tok-refreshed"]);
  });

  it("a sign-in that can't be refreshed answers with a plain MCP error, never the old token", async () => {
    upstreams.docs = upstreamOf(
      { name: "docs", transport: "http", url: up.url(), headers: { Authorization: "Bearer tok-at-start" } },
      async () => null,
    );
    const body = (await (await post("docs", callTool("echo", {}))).json()) as { error: { message: string } };
    expect(body.error.message).toBe("docs needs you to sign in again in ion");
    expect(up.seen).toHaveLength(0);
  });

  it("an unknown key, or one revoked when the run ended, is refused", async () => {
    expect(
      (await post("docs", rpc("tools/list"), { authorization: `Bearer ${"0".repeat(64)}` })).status,
    ).toBe(401);
    grants.revoke("r1");
    expect((await post("docs", rpc("tools/list"))).status).toBe(401);
    expect(up.seen).toHaveLength(0);
  });

  it("an ion's turn key isn't a run's: refused", async () => {
    key = grants.create({ kind: "ion", ionId: "chief", projects: [], turnId: "t1" });
    expect((await post("docs", rpc("tools/list"))).status).toBe(401);
  });

  it("a tools/call on a server not given to this run is refused", async () => {
    const r = await post("other", callTool("echo", {}));
    expect(r.status).toBe(404);
    expect(gated).toHaveLength(0);
    expect(up.seen).toHaveLength(0);
  });

  it("a browser (any Origin) is refused", async () => {
    expect((await post("docs", rpc("tools/list"), { origin: "https://evil.example" })).status).toBe(403);
  });

  it("a denied call returns isError with the reason and never reaches your server", async () => {
    decision = { decision: "deny", reason: "Touches ion's own files" };
    const r = await post("docs", callTool("read_file", { path: "~/.config/ion/mcp.json" }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "Touches ion's own files" }], isError: true },
    });
    expect(up.seen).toHaveLength(0);
  });

  it("passes other methods through as they are, ungated", async () => {
    const r = await post("docs", rpc("tools/list"));
    expect(await r.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
    });
    expect(gated).toHaveLength(0);
  });

  it("Mcp-Session-Id and SSE pass through", async () => {
    const init = await post("docs", rpc("initialize"));
    expect(init.headers.get("mcp-session-id")).toBe("sess-1");
    const r = await post("docs", callTool("stream", {}), { "mcp-session-id": "sess-1" });
    expect(up.seen.at(-1)!.headers["mcp-session-id"]).toBe("sess-1");
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    const text = await r.text();
    expect(text).toContain("notifications/progress");
    expect(text).toContain('"id":1');
    const get = await fetch(at("docs"), {
      headers: { authorization: `Bearer ${key}`, accept: "text/event-stream", "mcp-session-id": "sess-1" },
    });
    expect(await get.text()).toContain("notifications/ping");
    const del = await fetch(at("docs"), {
      method: "DELETE",
      headers: { authorization: `Bearer ${key}`, "mcp-session-id": "sess-1" },
    });
    expect(del.status).toBe(200);
    expect(up.seen.map((s) => s.method)).toEqual(["POST", "POST", "GET", "DELETE"]);
  });

  it("a server that can't be reached answers the agent with a plain MCP error, the run goes on", async () => {
    upstreams.docs = upstreamOf({
      name: "docs",
      transport: "http",
      url: "http://127.0.0.1:1/mcp",
      headers: {},
    });
    const r = await post("docs", callTool("echo", {}));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "ion couldn't reach docs" },
    });
  });

  it("a server error (5xx) is a plain MCP error too", async () => {
    const r = await post("docs", callTool("boom", {}));
    expect(await r.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "docs had a problem (500)" },
    });
  });

  // Task review, 2026-11-20 (automated security review): JSON.parse keeps a duplicated key's last value, but your
  // server may read the first: the call gated must be the call sent.
  it("a body with a duplicated arguments key is refused, and what's sent is exactly what was gated", async () => {
    const dup =
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"p":"/etc/passwd"},"arguments":{"p":"a.txt"}}}';
    const r = await postRaw("docs", dup);
    expect(await r.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "ion couldn't read this request" },
    });
    expect(gated).toHaveLength(0);
    expect(up.seen).toHaveLength(0);
    const spaced =
      '{ "jsonrpc": "2.0", "id": 2, "method": "tools/call",\n "params": {"name": "echo", "arguments": {"p": "a\\u0062"}}}';
    await postRaw("docs", spaced);
    expect(up.seen.at(-1)!.raw).toBe(JSON.stringify(JSON.parse(spaced)));
    expect(gated.at(-1)!.input).toEqual({ p: "ab" });
  });

  // Task review, 2026-11-20 (automated security review): reading a resource or getting a prompt reads or acts
  // too; only listing and the handshake pass ungated, anything else is refused.
  it("gates resources/read, resources/subscribe, prompts/get and completion/complete like a tool call", async () => {
    const calls: [string, object][] = [
      ["resources/read", { uri: "file:///etc/passwd" }],
      ["resources/subscribe", { uri: "file:///a" }],
      ["prompts/get", { name: "summarize", arguments: { topic: "x" } }],
      ["completion/complete", { ref: { type: "ref/prompt", name: "summarize" } }],
    ];
    for (const [method, params] of calls) await post("docs", rpc(method, params));
    expect(gated.map((g) => [g.kind, g.mcpServer, g.toolName, g.input])).toEqual(
      calls.map(([method, params]) => ["mcp", "docs", method, params]),
    );
    decision = { decision: "deny", reason: "Not for this task" };
    const r = await post("docs", rpc("resources/read", { uri: "file:///etc/passwd" }));
    expect(await r.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "Not for this task" },
    });
    expect(up.seen).toHaveLength(4);
  });

  it("passes only the handshake, lists and notifications ungated; refuses anything else", async () => {
    for (const m of [
      "initialize",
      "ping",
      "tools/list",
      "resources/list",
      "resources/templates/list",
      "prompts/list",
    ])
      await post("docs", rpc(m));
    await post("docs", { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(gated).toHaveLength(0);
    expect(up.seen).toHaveLength(7);
    for (const m of ["logging/setLevel", "sampling/createMessage", "tools/delete"]) {
      const r = await post("docs", rpc(m));
      expect(await r.json()).toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: `ion doesn't pass ${m} on` },
      });
    }
    expect(up.seen).toHaveLength(7);
  });

  // Task review, 2026-11-21 (security review): Streamable HTTP (2025-06-18) has no batches; one with a call hidden
  // among harmless messages must never reach your server.
  it("refuses a batch outright", async () => {
    const r = await post("docs", [
      rpc("tools/list"),
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]);
    expect(await r.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "ion takes one message at a time" },
    });
    expect(up.seen).toHaveLength(0);
    expect(gated).toHaveLength(0);
  });
});

// The user, 2026-11-21 ("Read-only use"): an ion's turn reaches your servers through ion's gateway too, with its turn's
// key; ion's gate for ions decides each call; the key never opens another turn's servers or a run's.
describe("an ion's turn through the gateway", () => {
  it("an ion's MCP call goes through the gateway with no key in its environment", async () => {
    const ionGated: { turnId: string; call: GateCall }[] = [];
    let ionSays: { decision: "allow" | "deny"; reason?: string } = { decision: "allow" };
    const gateway = createGateway({
      grants,
      upstream: () => null,
      gate: async () => ({ decision: "deny" }),
      ion: {
        upstream: (turnId, name) => (turnId === "turn_1" ? (upstreams[name] ?? null) : null),
        gate: async (turnId, call) => {
          ionGated.push({ turnId, call });
          return ionSays;
        },
      },
    });
    const srv = createServer((req, res) => void gateway.handle(req, res));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const turnKey = grants.create({ kind: "ion", ionId: "chief", projects: [], turnId: "turn_1" });
    const other = grants.create({ kind: "ion", ionId: "chief", projects: [], turnId: "turn_2" });
    const send = (k: string, body: object) =>
      fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp/s/docs`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${k}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
      });
    const r = await send(turnKey, callTool("echo", { q: "hi" }));
    const text = ((await r.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text;
    // Your key is added by ion; the ion's agent held only its turn key.
    expect(JSON.parse(text)).toMatchObject({ args: { q: "hi" } });
    expect(up.seen.at(-1)?.headers["x-api-key"]).toBe("key-secret-1");
    expect(ionGated).toEqual([
      { turnId: "turn_1", call: expect.objectContaining({ toolName: "echo", mcpServer: "docs" }) },
    ]);
    ionSays = { decision: "deny", reason: "That changes something, so I'll start a chat" };
    const no = (await (await send(turnKey, callTool("echo", {}))).json()) as { result: { isError: boolean } };
    expect(no.result.isError).toBe(true);
    expect((await send(other, callTool("echo", {}))).status).toBe(404);
    srv.close();
  });
});
