import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type ApiError,
  type IonEvent,
  type Push,
  type Reply,
  type Request,
  UNAUTHORIZED_CLOSE,
} from "@ion/schema";
import { WebSocketServer } from "ws";
import { EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { type Ctx, handlers, UserError } from "./commands.js";

export const VERSION = "0.0.0";

export async function startServer(opts: {
  dataDir: string;
  configFile: string;
  port?: number;
}): Promise<{ port: number; token: string; close(): Promise<void> }> {
  mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
  const db = openDb(join(opts.dataDir, "ion.db"));
  const store = new EventStore(db, allViews);
  const ctx: Ctx = { store, configFile: opts.configFile, startedAt: Date.now(), version: VERSION };
  const token = randomBytes(24).toString("base64url");

  const wss = new WebSocketServer({ host: "127.0.0.1", port: opts.port ?? 0 });
  await new Promise<void>((r) => wss.once("listening", r));

  wss.on("connection", (ws, req) => {
    const given = new URL(req.url ?? "/", "http://x").searchParams.get("token");
    if (given !== token) return ws.close(UNAUTHORIZED_CLOSE, "Unauthorized");

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
          backlog = store.read({ chatId: q.chatId, afterId: q.afterId });
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
