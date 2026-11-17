import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readDaemonInfo } from "./index.js";

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

describe("connect", () => {
  // Regression (CodeQL js/unvalidated-dynamic-method-call): server messages pick which handler runs.
  it("ignores malformed or unknown messages from the server", async () => {
    const { WebSocketServer } = await import("ws");
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, handleProtocols: () => "ion" });
    await new Promise((r) => wss.once("listening", r));
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const { id } = JSON.parse(String(raw));
        for (const junk of ["not json", "null", '{"sub":"__proto__","event":{}}', '{"sub":42}', '{"id":7}'])
          ws.send(junk);
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
