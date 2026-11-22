import { describe, expect, it } from "vitest";
import type { LocalUpstream } from "../gateway/index.js";
import { ServerAsks } from "./server-asks.js";

const resources = Array.from({ length: 60 }, (_, i) => ({
  uri: `file:///r/${i}`,
  name: `Doc ${i}\u001b[2J`,
}));
const local: LocalUpstream = {
  send: async (m: unknown) => {
    const { id, method } = m as { id: number; method: string };
    if (method === "resources/list") return { jsonrpc: "2.0", id, result: { resources } };
    return { jsonrpc: "2.0", id, result: { tools: [{ name: "echo" }] } };
  },
};
const asks = () =>
  new ServerAsks({
    dataDir: "/nonexistent",
    servers: async () => ({
      specs: [{ name: "notes", transport: "stdio", command: "notes-mcp", args: [], env: {} }],
      skipped: [],
      secrets: [],
      fresh: {},
      refs: [],
    }),
    local: () => local,
  });

// Task review, 2026-11-21: "@" lists a server's resources for servers ion runs (names cleaned, at most 50).
describe("a server's resources for @", () => {
  it("lists at most 50, with control characters stripped", async () => {
    const r = await asks().resources("notes");
    expect(r).toHaveLength(50);
    expect(r[0]).toEqual({ name: "Doc 0[2J", uri: "file:///r/0" });
    expect(await asks().resources("other")).toEqual([]);
    expect(await asks().tools("notes")).toEqual([{ name: "echo" }]);
  });
});

// Task 11, 2026-11-22 (tour): a server that's on but not signed in said "Turn it on to see its tools".
describe("why a server's tools can't be listed", () => {
  it("says why it was left out, not to turn it on", async () => {
    const a = new ServerAsks({
      dataDir: "/nonexistent",
      servers: async () => ({
        specs: [],
        skipped: [{ id: "notes", text: "notes isn't signed in, so this chat runs without it." }],
        secrets: [],
        fresh: {},
        refs: [],
      }),
      local: () => local,
    });
    expect(await a.tools("notes")).toBe("notes isn't signed in");
    expect(await a.tools("other")).toBe("Turn it on to see its tools");
  });
});
