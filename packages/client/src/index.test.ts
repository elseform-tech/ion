import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { daemonUrl, readDaemonInfo } from "./index.js";

const dirWith = (x: unknown) => {
  const d = mkdtempSync(join(tmpdir(), "ion-info-"));
  writeFileSync(join(d, "daemon.json"), JSON.stringify(x));
  return d;
};

describe("readDaemonInfo", () => {
  it("reads a valid file", () => {
    expect(readDaemonInfo(dirWith({ pid: 1, port: 4000, token: "t" }))).toEqual({
      pid: 1,
      port: 4000,
      token: "t",
    });
  });
  it("rejects ports outside 1–65535 and a missing pid", () => {
    expect(readDaemonInfo(dirWith({ pid: 1, port: 0, token: "t" }))).toBeNull();
    expect(readDaemonInfo(dirWith({ pid: 1, port: 70000, token: "t" }))).toBeNull();
    expect(readDaemonInfo(dirWith({ port: 4000, token: "t" }))).toBeNull();
  });
  it("returns null when the file is missing", () => {
    expect(readDaemonInfo(mkdtempSync(join(tmpdir(), "ion-none-")))).toBeNull();
  });
});

// CodeQL on main, 2026-11-22 (js/file-access-to-http): ion's token went to any host asked for.
describe("daemonUrl", () => {
  it("is this computer only", () => {
    expect(daemonUrl(4000)).toBe("ws://127.0.0.1:4000/");
    expect(daemonUrl(4000, "::1")).toBe("ws://[::1]:4000/");
    // Review, 2026-11-22: "localhost" can resolve elsewhere; only numeric loopback is connected to.
    expect(daemonUrl(4000, "localhost")).toBe("ws://127.0.0.1:4000/");
    for (const h of [
      "example.com",
      "ion.example.org",
      "127.0.0.1.evil.com",
      "0.0.0.0",
      "__proto__",
      "localhost:80@x",
    ])
      expect(() => daemonUrl(4000, h)).toThrow(/only to this computer/);
    expect(() => daemonUrl(0)).toThrow(/not a port/);
  });

  it("refuses to send the token anywhere else", async () => {
    const { connect } = await import("./index.js");
    await expect(connect({ port: 4000, host: "example.com", token: "t" })).rejects.toThrow(
      /only to this computer/,
    );
  });
});

describe("connect", () => {
  // Regression (CodeQL js/unvalidated-dynamic-method-call): server messages pick which handler runs.
  it("ignores malformed or unknown messages from the server", async () => {
    const { WebSocketServer } = await import("ws");
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, handleProtocols: () => "ion" });
    await new Promise((r) => wss.once("listening", r));
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const { id } = JSON.parse(String(raw));
        const junk = [
          "not json",
          "null",
          '{"sub":"__proto__","event":{}}',
          '{"sub":42}',
          '{"id":7}',
          JSON.stringify({ id, ok: false }), // error reply without an error
          JSON.stringify({ id, ok: true, sub: "s1", event: {} }), // both kinds at once
          JSON.stringify({ sub: "s1", event: { type: "nope" } }), // not a valid event
        ];
        for (const j of junk) ws.send(j);
        ws.send(JSON.stringify({ id, ok: true, result: { pid: 1 } }));
      });
    });
    const port = (wss.address() as { port: number }).port;
    const { connect } = await import("./index.js");
    const client = await connect({ port, token: "t" });
    await expect(client.call("status", {})).resolves.toEqual({ pid: 1 });
    client.close();
    await new Promise((r) => wss.close(r));
  });
});
