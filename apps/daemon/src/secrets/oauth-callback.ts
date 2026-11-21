import { createServer, type Server } from "node:http";

/** Where your browser comes back after signing in: 47291, else the next free of 47292–47299. */
export const CALLBACK_PORTS = Array.from({ length: 9 }, (_x, i) => 47291 + i);

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'",
  "x-content-type-options": "nosniff",
};

export type Callback = (q: URLSearchParams) => Promise<{ ok: boolean; page: string }>;

/**
 * The callback's own listener on 127.0.0.1, open only while a sign-in waits: the same port every time it can be
 * (so a client ID you registered keeps working), a small plain page for the browser, nothing else served.
 */
export class CallbackPort {
  private srv: Server | null = null;
  private port = 0;

  /** `idle`: no sign-in waits any more (then it closes once the page is sent). */
  constructor(
    private readonly handle: Callback,
    private readonly idle: () => boolean,
    private readonly ports: number[] = CALLBACK_PORTS,
  ) {}

  /** The port it listens on, opened if it wasn't; null when none of its ports is free. */
  async open(): Promise<number | null> {
    if (this.srv) return this.port;
    for (const port of this.ports) {
      const srv = this.serve();
      const ok = await new Promise<boolean>((r) => {
        srv.once("error", () => r(false));
        srv.listen(port, "127.0.0.1", () => r(true));
      });
      if (ok) {
        srv.on("error", () => {});
        this.srv = srv;
        this.port = port;
        return port;
      }
    }
    return null;
  }

  async close(): Promise<void> {
    const srv = this.srv;
    this.srv = null;
    if (!srv) return;
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => r()));
  }

  private serve(): Server {
    return createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.pathname !== "/oauth/callback") return void res.writeHead(404).end();
      if (req.method !== "GET") return void res.writeHead(405, { allow: "GET" }).end();
      res.on("close", () => {
        if (this.idle()) this.close().catch(() => {});
      });
      this.handle(u.searchParams).then(
        (r) => res.writeHead(r.ok ? 200 : 400, { ...HEADERS, connection: "close" }).end(r.page),
        () => res.destroy(),
      );
    });
  }
}
