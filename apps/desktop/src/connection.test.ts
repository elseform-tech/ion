import type { IonClient } from "@ion/client/browser";
import { describe, expect, it, vi } from "vitest";
import { IonConnection } from "./connection.js";

/** A client whose close the test triggers. */
function fakeClient() {
  const closers: (() => void)[] = [];
  const client = {
    call: vi.fn(),
    subscribe: vi.fn(),
    close: () => closers.forEach((f) => f()),
    onClose: (f: () => void) => void closers.push(f),
  } as unknown as IonClient;
  return client;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("IonConnection", () => {
  it("is down while ion isn't running, then up once it is", async () => {
    let info: { port: number; token: string } | null = null;
    const connect = vi.fn(async () => fakeClient());
    const c = new IonConnection({ info: async () => info, connect, retryMs: 5 });
    c.start();
    await tick();
    expect(c.state).toBe("down");
    info = { port: 4100, token: "t" };
    await vi.waitFor(() => expect(c.state).toBe("up"));
    expect(connect).toHaveBeenCalledWith({ port: 4100, token: "t" });
    c.stop();
  });

  // Review Focus 1: the daemon restarts with a new port and token while the app is open.
  it("goes down when the connection closes and reconnects to the new daemon", async () => {
    let info = { port: 4100, token: "a" };
    const clients: IonClient[] = [];
    const connect = vi.fn(async () => {
      const k = fakeClient();
      clients.push(k);
      return k;
    });
    const c = new IonConnection({ info: async () => info, connect, retryMs: 5 });
    const states: string[] = [];
    c.subscribe(() => states.push(c.state));
    c.start();
    await vi.waitFor(() => expect(c.state).toBe("up"));
    info = { port: 4200, token: "b" };
    clients[0]!.close();
    expect(c.state).toBe("down");
    await vi.waitFor(() => expect(c.state).toBe("up"));
    expect(connect).toHaveBeenLastCalledWith({ port: 4200, token: "b" });
    expect(c.client).toBe(clients[1]);
    expect(states).toContain("down");
    c.stop();
  });

  // Plan 21 audit, 2026-11-23: the app opened on "ion isn't running. Start it with: ion daemon start", a terminal
  // command a beginner doesn't know. The app starts ion itself where it can (once), and says so while it waits.
  it("starts ion itself once when it isn't running, and says Starting while it waits", async () => {
    let info: { port: number; token: string } | null = null;
    const start = vi.fn(async () => {
      setTimeout(() => {
        info = { port: 4100, token: "t" };
      }, 300);
      return true;
    });
    const c = new IonConnection({
      info: async () => info,
      connect: async () => fakeClient(),
      start,
      retryMs: 5,
    });
    c.start();
    await vi.waitFor(() => expect(c.state).toBe("starting"));
    await vi.waitFor(() => expect(c.state).toBe("up"));
    expect(start).toHaveBeenCalledTimes(1);
    c.stop();
  });

  it("is down, with the command, when ion couldn't be started", async () => {
    const c = new IonConnection({
      info: async () => null,
      connect: async () => fakeClient(),
      start: async () => false,
      retryMs: 5,
    });
    c.start();
    await vi.waitFor(() => expect(c.state).toBe("down"));
    await tick();
    expect(c.state).toBe("down");
    c.stop();
  });
});
