import { describe, expect, it } from "vitest";
import { connectBrowser } from "./browser.js";

/** A stand-in for the browser's WebSocket, driven by the test. */
const made: FakeSocket[] = [];
class FakeSocket {
  static get last(): FakeSocket {
    return made.at(-1)!;
  }
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(
    public url: string,
    public protocols: string[],
  ) {
    made.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(s: string) {
    this.sent.push(s);
  }
  close() {
    this.onclose?.();
  }
  reply(o: unknown) {
    this.onmessage?.({ data: JSON.stringify(o) });
  }
}

const event = (id: string) => ({
  v: 1,
  id,
  chatId: "c1",
  runId: null,
  seq: 1,
  ts: "2026-11-18T10:00:00.000Z",
  origin: "daemon",
  type: "chat.archived",
  data: {},
});

describe("connectBrowser", () => {
  it("authenticates with the subprotocols, answers calls and delivers backlog pushed with the reply", async () => {
    const c = await connectBrowser({ port: 4100, token: "tok", WebSocket: FakeSocket as never });
    const s = FakeSocket.last;
    expect(s.url).toBe("ws://127.0.0.1:4100/");
    expect(s.protocols).toEqual(["ion", "ion.token.tok"]);
    const status = c.call("status", {});
    s.reply({ id: "1", ok: true, result: { projects: 2 } });
    expect(await status).toEqual({ projects: 2 });

    const seen: string[] = [];
    const sub = c.subscribe({ chatId: "c1" }, (e) => seen.push(e.id));
    // The daemon sends the backlog right after its reply; a push may even beat the reply.
    s.reply({ sub: "s1", event: event("e0") });
    s.reply({ id: "2", ok: true, result: { sub: "s1" } });
    await sub;
    s.reply({ sub: "s1", event: event("e1") });
    expect(seen).toEqual(["e0", "e1"]);
  });

  it("rejects pending calls and tells listeners when the connection closes", async () => {
    const c = await connectBrowser({ port: 1, token: "t", WebSocket: FakeSocket as never });
    let closed = false;
    c.onClose(() => {
      closed = true;
    });
    const p = c.call("status", {});
    FakeSocket.last.close();
    await expect(p).rejects.toThrow("Connection closed");
    expect(closed).toBe(true);
  });
});
