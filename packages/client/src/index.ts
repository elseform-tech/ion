import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiError, Command, Commands, IonEvent, Push, Reply } from "@ion/schema";
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
}

/** A reply or a push, or null for anything else. Only own string keys reach the handler maps. */
function parseMessage(raw: string): Reply | Push | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof m !== "object" || m === null) return null;
  const o = m as Record<string, unknown>;
  if (typeof o.sub === "string" && typeof o.event === "object" && o.event !== null) return o as Push;
  if (typeof o.id === "string" && typeof o.ok === "boolean") return o as unknown as Reply;
  return null;
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
  ws.on("close", () => {
    for (const p of pending.values()) p.reject(new Error("Connection closed"));
    pending.clear();
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
        const m = JSON.parse(String(raw));
        if ("sub" in m) buffered.push(m);
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
  };
}
