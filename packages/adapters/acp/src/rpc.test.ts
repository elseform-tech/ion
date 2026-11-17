import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createRpc, RpcError } from "./rpc.js";

function pair() {
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  const rpc = createRpc({ stdin: toAgent, stdout: fromAgent });
  const sent: unknown[] = [];
  toAgent.on("data", (d) =>
    String(d)
      .trim()
      .split("\n")
      .forEach((l) => sent.push(JSON.parse(l))),
  );
  const reply = (m: object) => fromAgent.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  return { rpc, sent, reply, fromAgent };
}

describe("createRpc", () => {
  it("matches responses to requests, even out of order", async () => {
    const { rpc, reply } = pair();
    const a = rpc.request("a", {});
    const b = rpc.request("b", {});
    reply({ id: 2, result: "B" });
    reply({ id: 1, result: "A" });
    expect(await Promise.all([a, b])).toEqual(["A", "B"]);
  });

  it("rejects with the agent's error code", async () => {
    const { rpc, reply } = pair();
    const p = rpc.request("session/new", {});
    reply({ id: 1, error: { code: -32000, message: "Authentication required" } });
    await expect(p).rejects.toMatchObject({ code: -32000 });
    await expect(p).rejects.toBeInstanceOf(RpcError);
  });

  it("answers agent requests and delivers notifications; ignores junk lines", async () => {
    const { rpc, sent, reply, fromAgent } = pair();
    const notes: unknown[] = [];
    rpc.onNotification("session/update", (p) => notes.push(p));
    rpc.onRequest("session/request_permission", async () => ({ outcome: { outcome: "cancelled" } }));
    fromAgent.write("not json\n");
    reply({ method: "session/update", params: { x: 1 } });
    reply({ id: 7, method: "session/request_permission", params: {} });
    await new Promise((r) => setTimeout(r, 10));
    expect(notes).toEqual([{ x: 1 }]);
    expect(sent).toContainEqual({ jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "cancelled" } } });
  });

  it("rejects pending requests when the agent's output closes", async () => {
    const { rpc, fromAgent } = pair();
    const p = rpc.request("session/prompt", {});
    fromAgent.end();
    await expect(p).rejects.toThrow("The agent stopped");
  });

  // Regression (final review I4): writing to an agent that closed its stdin raised an unhandled EPIPE.
  it("survives a broken stdin and rejects further requests", async () => {
    const broken = new Writable({
      write(_chunk, _enc, cb) {
        cb(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      },
    });
    const rpc = createRpc({ stdin: broken, stdout: new PassThrough() });
    await expect(rpc.request("session/prompt", {})).rejects.toThrow("The agent stopped");
    await expect(rpc.request("again", {})).rejects.toThrow("The agent stopped");
  });
});
