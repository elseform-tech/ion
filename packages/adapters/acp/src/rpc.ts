import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";

/** A JSON-RPC error from the agent. `-32000` means sign-in is needed. */
export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;
type Handler = (params: Json) => Promise<unknown>;

export interface Rpc {
  request(method: string, params: Json): Promise<unknown>;
  notify(method: string, params: Json): void;
  onRequest(method: string, handler: Handler): void;
  onNotification(method: string, handler: (params: Json) => void): void;
}

/** Newline-delimited JSON-RPC 2.0 over an agent's stdin/stdout (the ACP transport). */
export function createRpc(io: { stdin: Writable; stdout: Readable }): Rpc {
  let nextId = 0;
  let closed = false;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const requestHandlers = new Map<string, Handler>();
  const notificationHandlers = new Map<string, (p: Json) => void>();
  const write = (m: Json) => {
    if (!closed) io.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  };

  const onRequestMessage = async (id: unknown, method: string, params: Json) => {
    const h = requestHandlers.get(method);
    if (!h) return write({ id, error: { code: -32601, message: "Method not found" } });
    try {
      write({ id, result: await h(params) });
    } catch (e) {
      write({ id, error: { code: -32603, message: (e as Error).message } });
    }
  };

  const onLine = (line: string) => {
    let m: Json;
    try {
      m = JSON.parse(line);
    } catch {
      return; // agents may log non-JSON; ACP says stdout is messages only, but don't trust it
    }
    if (typeof m.method === "string") {
      const params = (m.params ?? {}) as Json;
      if (m.id !== undefined) return void onRequestMessage(m.id, m.method, params);
      return notificationHandlers.get(m.method)?.(params);
    }
    const p = typeof m.id === "number" ? pending.get(m.id) : undefined;
    if (!p) return;
    pending.delete(m.id as number);
    const err = m.error as { code?: number; message?: string } | undefined;
    if (err) p.reject(new RpcError(err.code ?? -32603, err.message ?? "Agent error"));
    else p.resolve(m.result);
  };

  const lines = createInterface({ input: io.stdout });
  lines.on("line", onLine);
  const stop = () => {
    closed = true;
    for (const p of pending.values()) p.reject(new Error("The agent stopped"));
    pending.clear();
  };
  lines.on("close", stop);
  // An agent that closed its stdin (crashed, exiting) gives EPIPE on write: that ends the connection,
  // never the daemon.
  io.stdin.on("error", stop);

  return {
    request(method, params) {
      if (closed) return Promise.reject(new Error("The agent stopped"));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        write({ id, method, params });
      });
    },
    notify: (method, params) => write({ method, params }),
    onRequest: (method, handler) => void requestHandlers.set(method, handler),
    onNotification: (method, handler) => void notificationHandlers.set(method, handler),
  };
}
