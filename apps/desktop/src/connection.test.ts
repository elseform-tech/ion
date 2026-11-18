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
});
