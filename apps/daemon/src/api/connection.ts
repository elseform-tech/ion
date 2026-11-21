import type { ApiError, IonEvent, Push, Reply, Request } from "@ion/schema";
import type { WebSocket } from "ws";
import { readBacklog } from "./backlog.js";
import { type Ctx, handlers, UserError } from "./commands.js";
import { RUN_ENDED, type RunCaller, runRefusal } from "./run-calls.js";

type Handler = (args: unknown, ctx: Ctx) => unknown;

/**
 * One authenticated client: parses requests, runs commands, streams subscriptions. `caller`: a chat's agent (it came
 * with its run's key), which may only use ion's commands for tools.
 */
export class Connection {
  private readonly offs: (() => void)[] = [];
  private subN = 0;
  private readonly ctx: Ctx;

  constructor(
    private readonly ws: WebSocket,
    ctx: Ctx,
    private readonly caller?: RunCaller,
  ) {
    this.ctx = caller ? { ...ctx, caller: caller.scope } : ctx;
    // A bad frame or oversized message is this socket's problem, never the daemon's.
    ws.on("error", () => ws.terminate());
    ws.on("message", (raw) => this.onMessage(String(raw)));
    ws.on("close", () => this.offs.forEach((off) => off()));
  }

  private send(m: Reply | Push): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(m));
  }

  private fail(id: string, code: ApiError["code"], message: string): void {
    this.send({ id, ok: false, error: { code, message } });
  }

  private onMessage(raw: string): void {
    const req = parseRequest(raw);
    if (!req) return this.fail("", "bad_request", "Bad request");
    const args = (req.args ?? {}) as Record<string, unknown>;
    if (this.caller && !this.caller.live()) {
      this.fail(req.id, "invalid", RUN_ENDED);
      return void this.ws.close();
    }
    const refused = this.caller ? runRefusal(req.cmd) : null;
    if (refused) return this.fail(req.id, "invalid", refused);
    if (req.cmd === "events.subscribe") return this.subscribe(req.id, args);
    void this.run(req.id, req.cmd, args);
  }

  private async run(id: string, cmd: string, args: unknown): Promise<void> {
    const h = (handlers as Record<string, Handler>)[cmd];
    if (!h) return this.fail(id, "unknown_command", `Unknown command: ${cmd}`);
    try {
      this.send({ id, ok: true, result: await h(args, this.ctx) } as Reply);
    } catch (e) {
      if (e instanceof UserError) this.fail(id, "invalid", e.message);
      else this.fail(id, "internal", "Something went wrong");
    }
  }

  /** Backlog then live events. Reads and appends are synchronous, so nothing can slip in between. */
  private subscribe(id: string, q: { chatId?: string; afterId?: string; fromNow?: boolean }): void {
    let backlog: IonEvent[];
    try {
      backlog = readBacklog(this.ctx.store, q);
    } catch (e) {
      return this.fail(id, "invalid", (e as Error).message);
    }
    const sub = `s${++this.subN}`;
    this.send({ id, ok: true, result: { sub } });
    for (const event of backlog) this.send({ sub, event });
    const off = this.ctx.store.onAppend((event) => {
      if (q.chatId === undefined || event.chatId === q.chatId) this.send({ sub, event });
    });
    this.offs.push(off);
  }
}

function parseRequest(raw: string): Request | null {
  try {
    const req = JSON.parse(raw) as Request;
    return typeof req.id === "string" && typeof req.cmd === "string" ? req : null;
  } catch {
    return null;
  }
}
