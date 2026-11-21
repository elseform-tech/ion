import type { GateCall } from "@ion/adapter-kit";
import type { GateAnswer } from "../gate/index.js";

type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
export type RpcId = string | number | null;

/** A JSON-RPC request's id (a notification has none). */
export const idOf = (m: unknown): RpcId => {
  const id = (m as Message | null)?.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
};

const rpcError = (id: RpcId, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

/** What passes ungated: the handshake, lists and notifications (nothing that reads or acts on your server). */
const PASS = new Set([
  "initialize",
  "ping",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "prompts/list",
]);
/** What reads or acts: decided by ion first, like a tool call. */
const GATED = new Set([
  "tools/call",
  "resources/read",
  "resources/subscribe",
  "prompts/get",
  "completion/complete",
]);

const isObject = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);

/** The agent's answer to a request of your server's (no method; a result or an error): passed on. */
const isResponse = (m: Message) =>
  m.method === undefined && m.id !== undefined && ("result" in m || "error" in m);

const passes = (m: unknown): boolean => {
  if (!isObject(m)) return false;
  const method = (m as Message).method;
  if (method === undefined) return isResponse(m as Message);
  return typeof method === "string" && (PASS.has(method) || method.startsWith("notifications/"));
};

/** A JSON text's tokens that matter here: strings (escapes kept) and structure. */
const TOKENS = /"(?:[^"\\]|\\.)*"|[{}[\],:]/g;

type Level = { keys: Set<string>; expectKey: boolean } | null;

/** One token: true when it's a key its object already has. */
function seenAgain(stack: Level[], token: string): boolean {
  const top = stack.at(-1);
  if (token.startsWith('"')) {
    if (!top?.expectKey) return false;
    const key = JSON.parse(token) as string;
    top.expectKey = false;
    if (top.keys.has(key)) return true;
    top.keys.add(key);
  } else if (token === "{") stack.push({ keys: new Set(), expectKey: true });
  else if (token === "[") stack.push(null);
  else if (token === "}" || token === "]") stack.pop();
  else if (token === "," && top) top.expectKey = true;
  return false;
}

/**
 * Whether a JSON text names a key twice in one object: JSON.parse keeps the last, your server may read the first,
 * so ion would gate one call and send another. Keys compare as decoded (a key spelled with a unicode escape is the same key).
 */
export function hasDuplicateKeys(text: string): boolean {
  const stack: Level[] = [];
  return [...text.matchAll(TOKENS)].some((m) => seenAgain(stack, m[0]));
}

/** The call ion decides for a gated method: a tool by its name and arguments, anything else by its method and params. */
function callOf(server: string, method: string, params0: unknown): GateCall | null {
  if (!isObject(params0)) return null;
  const params = params0;
  if (method !== "tools/call")
    return {
      toolName: method,
      kind: "mcp",
      mcpServer: server,
      summary: `${method} (${server})`,
      input: params,
    };
  const args = params.arguments ?? {};
  if (typeof params.name !== "string" || !isObject(args)) return null;
  return {
    toolName: params.name,
    kind: "mcp",
    mcpServer: server,
    summary: `${params.name} (${server})`,
    input: args,
  };
}

/**
 * What ion answers instead of sending a message on, or null to send it. Handshake, lists, notifications and the
 * agent's answers pass; a tool call, reading a resource, getting a prompt or a completion is decided by ion with
 * its real name and input (a refused tool call gets the reason as its result, isError; the rest a JSON-RPC
 * error); anything else is refused. (The gateway refuses batches before this.)
 */
export async function decided(
  gate: (call: GateCall) => Promise<GateAnswer>,
  server: string,
  body: unknown,
): Promise<unknown> {
  if (passes(body)) return null;
  const m = (isObject(body) ? body : {}) as Message;
  const method = typeof m.method === "string" ? m.method : "";
  if (!GATED.has(method)) return rpcError(idOf(m), -32601, `ion doesn't pass ${method || "this"} on`);
  const call = callOf(server, method, m.params ?? {});
  if (!call) return rpcError(idOf(m), -32602, "ion couldn't read this call");
  const a = await gate(call);
  return a.decision === "allow" ? null : refusal(method, idOf(m), a.reason ?? "Not allowed");
}

/** A refused tool call gets the reason as its result (the agent reads it); any other method, an error. */
const refusal = (method: string, id: RpcId, reason: string) =>
  method === "tools/call"
    ? { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: reason }], isError: true } }
    : rpcError(id, -32000, reason);
