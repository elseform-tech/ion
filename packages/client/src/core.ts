import {
  type ApiError,
  type Command,
  type Commands,
  type IonEvent,
  parseEvent,
  type Push,
  type Reply,
} from "@ion/schema";

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

/** The few things the client needs from a WebSocket, so Node's `ws` and the browser's both fit. */
export type MiniSocket = {
  send(text: string): void;
  close(): void;
  onMessage(fn: (text: string) => void): void;
  onClose(fn: () => void): void;
};

/** The subprotocols that authenticate: the token rides here, never in the URL. */
export const protocols = (token: string) => ["ion", `ion.token.${token}`];

/** At most this many early pushes per subscription (a chat's backlog, before the reply is read). */
const EARLY_MAX = 100_000;

/** A client over an open socket: calls matched to replies, and subscription pushes to their handlers. */
export function createClient(ws: MiniSocket): IonClient {
  let n = 0;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const subs = new Map<string, (e: IonEvent) => void>();
  // Backlog can arrive with (or before) the reply that names its subscription: kept until it's known, but only
  // while a subscribe is in flight and up to a limit. Pushes for nothing being subscribed are dropped.
  const early = new Map<string, IonEvent[]>();
  let subscribing = 0;
  const keepEarly = (sub: string, e: IonEvent) => {
    if (subscribing === 0) return;
    const list = early.get(sub) ?? [];
    if (list.length >= EARLY_MAX) return;
    list.push(e);
    early.set(sub, list);
  };
  ws.onMessage((raw) => {
    const msg = parseMessage(raw);
    if (!msg) return; // never let a malformed server message throw in the caller's process
    if ("sub" in msg) {
      const handler = subs.get(msg.sub);
      if (handler) handler(msg.event);
      else keepEarly(msg.sub, msg.event);
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new ApiCallError(msg.error.code, msg.error.message));
  });
  const closeListeners = new Set<() => void>();
  ws.onClose(() => {
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
      if (subscribing++ === 0) early.clear(); // nothing kept from before this subscribe
      let sub: string;
      try {
        ({ sub } = await call("events.subscribe", q));
      } finally {
        subscribing--;
      }
      subs.set(sub, onEvent);
      for (const e of early.get(sub) ?? []) onEvent(e);
      early.delete(sub);
      if (subscribing === 0) early.clear();
      return () => subs.delete(sub);
    },
    close: () => ws.close(),
    onClose: (fn) => void closeListeners.add(fn),
  };
}
