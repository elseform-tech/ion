import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ApiError,
  type Command,
  type Commands,
  type IonEvent,
  parseEvent,
  type Push,
  type Reply,
} from "@ion/schema";
import WebSocket from "ws";

export type DaemonInfo = { pid: number; port: number; token: string };

/** Reads `daemon.json` from the data dir, or null when it's missing or unreadable. */
export function readDaemonInfo(dataDir: string): DaemonInfo | null {
  try {
    const x = JSON.parse(readFileSync(join(dataDir, "daemon.json"), "utf8")) as DaemonInfo;
    const ok =
      Number.isInteger(x.pid) &&
      x.pid > 0 &&
      Number.isInteger(x.port) &&
      x.port >= 1 &&
      x.port <= 65535 &&
      typeof x.token === "string" &&
      x.token.length > 0;
    return ok ? x : null;
  } catch {
    return null;
  }
}

export class ApiCallError extends Error {
  constructor(
    public readonly code: ApiError["code"],
    message: string,
  ) {
    super(message);
  }
}

export interface IonClient {
  call<C extends Command>(cmd: C, args: Commands[C]["args"]): Promise<Commands[C]["result"]>;
  subscribe(q: Commands["events.subscribe"]["args"], onEvent: (e: IonEvent) => void): Promise<() => void>;
  close(): void;
  /** Called when the connection to the daemon closes (the daemon stopped or crashed, or close() was called). */
  onClose(fn: () => void): void;
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

function asReply(o: Record<string, unknown>): Reply | null {
  if (o.ok === true && "result" in o) return o as unknown as Reply;
  const e = o.error;
  if (o.ok === false && isObject(e) && typeof e.code === "string" && typeof e.message === "string")
    return o as unknown as Reply;
  return null;
}

function asPush(o: Record<string, unknown>): Push | null {
  try {
    return { sub: o.sub as string, event: parseEvent(o.event) };
  } catch {
    return null;
  }
}

/**
 * A well-formed reply or push, else null. Exactly one of `id` (reply) or `sub` (push) must be present,
 * replies need a result or a full error, and pushed events must pass the schema.
 */
function parseMessage(raw: string): Reply | Push | null {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(o)) return null;
  const isReply = typeof o.id === "string";
  const isPush = typeof o.sub === "string";
  if (isReply === isPush) return null;
  return isReply ? asReply(o) : asPush(o);
}

/** Opens an authenticated connection to the daemon. */
export async function connect(opts: { port: number; token: string; host?: string }): Promise<IonClient> {
  // The token rides in the subprotocol list, never the URL.
  const ws = new WebSocket(`ws://${opts.host ?? "127.0.0.1"}:${opts.port}/`, [
    "ion",
    `ion.token.${opts.token}`,
  ]);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  let n = 0;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const subs = new Map<string, (e: IonEvent) => void>();
  ws.on("message", (raw) => {
    const msg = parseMessage(String(raw));
    if (!msg) return; // never let a malformed server message throw in the caller's process
    if ("sub" in msg) {
      const handler = subs.get(msg.sub);
      if (typeof handler === "function") handler(msg.event);
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new ApiCallError(msg.error.code, msg.error.message));
  });
  const closeListeners = new Set<() => void>();
  ws.on("close", () => {
    for (const p of pending.values()) p.reject(new Error("Connection closed"));
    pending.clear();
    for (const fn of closeListeners) fn();
  });

  const call: IonClient["call"] = (cmd, args) =>
    new Promise((resolve, reject) => {
      const id = String(++n);
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ id, cmd, args }));
    });

  return {
    call,
    async subscribe(q, onEvent) {
      // Register before asking, so backlog pushes that arrive with the reply aren't lost.
      const buffered: Push[] = [];
      const id = String(++n);
      const early = (raw: WebSocket.RawData) => {
        const m = parseMessage(String(raw));
        if (m && "sub" in m) buffered.push(m);
      };
      ws.on("message", early);
      const { sub } = await new Promise<{ sub: string }>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        ws.send(JSON.stringify({ id, cmd: "events.subscribe", args: q }));
      });
      ws.off("message", early);
      subs.set(sub, onEvent);
      for (const m of buffered) if (m.sub === sub) onEvent(m.event);
      return () => subs.delete(sub);
    },
    close: () => ws.close(),
    onClose: (fn) => void closeListeners.add(fn),
  };
}
