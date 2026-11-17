import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type ApiError, type IonEvent, type Push, type Reply, type Request } from "@ion/schema";
import type { IncomingMessage } from "node:http";
import { WebSocketServer } from "ws";
import { EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { readBacklog } from "./backlog.js";
import { type Ctx, handlers, UserError } from "./commands.js";

export const VERSION = "0.0.0";
export const TOKEN_PREFIX = "ion.token.";

export async function startServer(opts: {
  dataDir: string;
  configFile: string;
  port?: number;
}): Promise<{ port: number; token: string; close(): Promise<void> }> {
  mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
  chmodSync(opts.dataDir, 0o700); // mkdir's mode doesn't touch a folder that already exists
  const db = openDb(join(opts.dataDir, "ion.db"));
  const store = new EventStore(db, allViews);
  const ctx: Ctx = { store, configFile: opts.configFile, startedAt: Date.now(), version: VERSION };
  const token = randomBytes(24).toString("base64url");

  // The token travels as a subprotocol ("ion.token.<token>"): browsers can set it, and it stays out of URLs.
  const digest = (x: string) => createHash("sha256").update(x).digest();
  const expected = digest(token);
  const authorized = (protocols: string[]) =>
    protocols.some(
      (p) => p.startsWith(TOKEN_PREFIX) && timingSafeEqual(digest(p.slice(TOKEN_PREFIX.length)), expected),
    );
  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port: opts.port ?? 0,
    maxPayload: 1024 * 1024,
    // Refuse at the handshake, so unauthenticated peers never reach frame parsing.
    verifyClient: (info: { req: IncomingMessage }) =>
      authorized(
        String(info.req.headers["sec-websocket-protocol"] ?? "")
          .split(",")
          .map((p) => p.trim()),
      ),
    handleProtocols: (protocols) => (protocols.has("ion") ? "ion" : false),
  });
  wss.on("error", () => {});
  await new Promise<void>((r) => wss.once("listening", r));

  wss.on("connection", (ws) => {
    // A bad frame or oversized message is that socket's problem, never the daemon's.
    ws.on("error", () => ws.terminate());
    const offs: (() => void)[] = [];
    let subN = 0;
    const send = (m: Reply | Push) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
    const fail = (id: string, code: ApiError["code"], message: string) =>
      send({ id, ok: false, error: { code, message } });

    ws.on("message", (raw) => {
      let req: Request;
      try {
        req = JSON.parse(String(raw));
        if (typeof req.id !== "string" || typeof req.cmd !== "string") throw new Error();
      } catch {
        return fail("", "bad_request", "Bad request");
      }
      const args = (req.args ?? {}) as Record<string, unknown>;
      if (req.cmd === "events.subscribe") {
        const q = args as { chatId?: string; afterId?: string };
        const match = (e: IonEvent) => q.chatId === undefined || e.chatId === q.chatId;
        const live: IonEvent[] = [];
        let replaying = true;
        const sub = `s${++subN}`;
        const off = store.onAppend((e) => (replaying ? live.push(e) : match(e) && send({ sub, event: e })));
        let backlog: IonEvent[];
        try {
          backlog = readBacklog(store, q);
        } catch (e) {
          off();
          return fail(req.id, "invalid", (e as Error).message);
        }
        offs.push(off);
        send({ id: req.id, ok: true, result: { sub } });
        const sent = new Set(backlog.map((e) => e.id));
        for (const e of backlog) send({ sub, event: e });
        for (const e of live) if (match(e) && !sent.has(e.id)) send({ sub, event: e });
        replaying = false;
        return;
      }
      const h = (handlers as Record<string, (a: unknown, c: Ctx) => unknown>)[req.cmd];
      if (!h) return fail(req.id, "unknown_command", `Unknown command: ${req.cmd}`);
      try {
        send({ id: req.id, ok: true, result: h(args, ctx) } as Reply);
      } catch (e) {
        if (e instanceof UserError) fail(req.id, "invalid", e.message);
        else fail(req.id, "internal", "Something went wrong");
      }
    });
    ws.on("close", () => {
      for (const off of offs) off();
    });
  });

  const addr = wss.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    token,
    close: async () => {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      db.close();
    },
  };
}
