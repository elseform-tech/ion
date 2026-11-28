import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveUserConfig } from "@ion/config";
import { describe, expect, it, vi } from "vitest";
import type { LocalUpstream } from "../gateway/index.js";
import { setIonUse } from "../tools/ion-use.js";
import { callLimit, IonServers } from "./servers.js";

const TOOLS = [
  { name: "search", description: "Search", annotations: { readOnlyHint: true } },
  { name: "remove", description: "Remove a note" },
];

/** A local server as ion's bridge serves it: tools/list, and tools/call echoing what it got. */
const local = (): LocalUpstream & { calls: unknown[] } => {
  const calls: unknown[] = [];
  return {
    calls,
    send: async (m: unknown) => {
      const { id, method, params } = m as { id: number; method: string; params: unknown };
      calls.push({ method, params });
      return { jsonrpc: "2.0", id, result: method === "tools/list" ? { tools: TOOLS } : {} };
    },
  };
};

function setup(verdict: "allow" | "deny" | "unsure" = "allow", ionUse: string[] = [], own: string[] = []) {
  const home = mkdtempSync(join(tmpdir(), "ion-ionsrv-"));
  const configFile = join(home, "config.toml");
  saveUserConfig(configFile, { ...DEFAULT_CONFIG, tools: { ...DEFAULT_CONFIG.tools, ionUse } });
  const judge = vi.fn(async () => ({ verdict, reason: verdict === "allow" ? "only reads" : "it deletes" }));
  const up = local();
  const s = new IonServers({
    configFile,
    dataDir: join(home, "data"),
    judge,
    servers: async () => ({
      specs: [
        {
          name: "notes",
          transport: "stdio",
          command: "notes-mcp",
          args: [],
          env: { NOTES_KEY: "sekrit-123456" },
        },
      ],
      skipped: [],
      secrets: ["sekrit-123456"],
      fresh: {},
      refs: ["NOTES_KEY"],
    }),
    local: () => up,
    ownNames: async () => own,
  });
  return { s, judge, up, configFile };
}
const call = (toolName: string, input: Record<string, unknown> = { q: "kiwi" }) => ({
  toolName,
  kind: "mcp",
  mcpServer: "notes",
  summary: `${toolName} (notes)`,
  input,
});

// The user, 2026-11-21: "Read-only use" — ions call a server's tool only when it only reads; anything that writes is
// a thread.
describe("ions and your servers", () => {
  it("an ion's turn gets ion's URLs and its turn key, never a key of yours", async () => {
    const { s } = setup();
    const given = await s.open(
      "turn_1",
      { url: "https://ion.test/mcp", key: "k".repeat(64) },
      { http: true },
    );
    expect(given.servers).toEqual([
      {
        name: "notes",
        transport: "http",
        url: "https://ion.test/mcp/s/notes",
        headers: { Authorization: `Bearer ${"k".repeat(64)}` },
      },
    ]);
    expect(JSON.stringify(given.servers)).not.toContain("sekrit");
    expect(given.envDrop).toEqual({ names: ["NOTES_KEY"], values: ["sekrit-123456"] });
    expect(s.upstream("turn_1", "notes")).not.toBeNull();
    await s.close("turn_1");
    expect(s.upstream("turn_1", "notes")).toBeNull();
  });

  it("an ion can call a read-only MCP tool", async () => {
    const { s, judge } = setup("allow");
    await s.open("turn_1", { url: "https://x.test/mcp", key: "k" }, { http: true });
    expect(await s.gate("turn_1", call("search"), "what's in my notes?")).toEqual({ decision: "allow" });
    expect(judge).toHaveBeenCalledWith(
      expect.objectContaining({ text: "what's in my notes?", onlyReads: true }),
    );
  });

  it("an ion can't call a tool that isn't read-only — it starts a thread", async () => {
    const off = setup("allow");
    await off.s.open("turn_1", { url: "https://x.test/mcp", key: "k" }, { http: true });
    const r = await off.s.gate("turn_1", call("remove"), "tidy my notes");
    expect(r).toEqual({ decision: "deny", reason: "That tool isn't on for ions, so I'll start a chat" });
    expect(off.judge).not.toHaveBeenCalled();
    const no = setup("deny");
    await no.s.open("turn_1", { url: "https://x.test/mcp", key: "k" }, { http: true });
    expect(await no.s.gate("turn_1", call("search"), "x")).toEqual({
      decision: "deny",
      reason: "That changes something, so I'll start a chat",
    });
    const unsure = setup("unsure");
    await unsure.s.open("turn_1", { url: "https://x.test/mcp", key: "k" }, { http: true });
    expect((await unsure.s.gate("turn_1", call("search"), "x")).reason).toBe(
      "ion isn't sure it only reads (it deletes), so I'll start a chat",
    );
    // Your switch turns an unlabelled tool on for ions.
    const yours = setIonUse([], "notes", TOOLS[1]!, true);
    const on = setup("allow", yours);
    await on.s.open("turn_1", { url: "https://x.test/mcp", key: "k" }, { http: true });
    expect(await on.s.gate("turn_1", call("remove"), "x")).toEqual({ decision: "allow" });
  });

  it("an ion's call with a long text or an encoded blob is refused", async () => {
    expect(callLimit({ q: "kiwi" })).toBeNull();
    expect(callLimit({ q: "a".repeat(201) })).toBe("That's too long for an ion's call, so I'll start a chat");
    expect(callLimit({ q: `x ${"QUJD".repeat(10)}` })).toBe(
      "That looks like encoded data, so I'll start a chat",
    );
    expect(callLimit({ q: "0123456789abcdef".repeat(3) })).toBe(
      "That looks like encoded data, so I'll start a chat",
    );
    expect(callLimit({ list: Array.from({ length: 30 }, () => "word ".repeat(19)) })).toBe(
      "That's too long for an ion's call, so I'll start a chat",
    );
    const { s, judge } = setup("allow");
    await s.open("turn_1", { url: "https://x.test/mcp", key: "k" }, { http: true });
    expect((await s.gate("turn_1", call("search", { q: "z".repeat(300) }), "x")).decision).toBe("deny");
    expect(judge).not.toHaveBeenCalled();
  });
});

// Task review, 2026-11-21: Grok also loads its own config.toml servers, so an ion's call to Grok's own server named
// like one of yours passed the hook as yours and skipped ion's read-only gate.
describe("an agent's own server named like yours", () => {
  it("an ion's call to an agent's own server named like yours is refused", async () => {
    const { s } = setup("allow", [], ["notes"]);
    const ion = { url: "https://ion.test/mcp", key: "k" };
    const given = await s.forTurn("turn_1", ion, { id: "grok-build", mcpTransports: { http: true } }, false);
    expect(given).toEqual([]);
    expect(s.names("turn_1")).toEqual([]);
    expect((await s.gate("turn_1", call("search"), "x")).decision).toBe("deny");
    expect(s.own("turn_1")).toEqual(["notes"]);
  });
});

// Task review, 2026-11-21: a tool's first look (by the gate, not only Settings) is kept, so a later change turns it off.
describe("a tool's first look", () => {
  it("is kept when the gate first sees it, and a later change turns it off for ions", async () => {
    const { s, configFile } = setup("allow");
    await s.open("turn_1", { url: "https://x.test/mcp", key: "k" }, { http: true });
    expect(await s.gate("turn_1", call("search"), "x")).toEqual({ decision: "allow" });
    const { loadUserConfig } = await import("@ion/config");
    expect(loadUserConfig(configFile).config.tools.ionUse.some((e) => e.startsWith("notes/search@"))).toBe(
      true,
    );
  });
});

// Task review, 2026-11-21: an ion's call the judge couldn't decide says so; an ion's unsure counts toward "often unsure".
describe("the judge on an ion's call", () => {
  it("says ion couldn't decide, and tells the log of unsure answers", async () => {
    const told: string[] = [];
    const home = mkdtempSync(join(tmpdir(), "ion-ionsrv-"));
    const configFile = join(home, "config.toml");
    saveUserConfig(configFile, DEFAULT_CONFIG);
    const make = (v: { verdict: "deny" | "unsure"; reason: string; decided?: false }) =>
      new IonServers({
        ...{ configFile, dataDir: join(home, "data"), judge: async () => v },
        servers: async () => ({
          specs: [{ name: "notes", transport: "stdio", command: "n", args: [], env: {} }],
          ...{ skipped: [], secrets: [], fresh: {}, refs: [] },
        }),
        local,
        onUnsure: (c) => told.push(c.toolName),
      });
    const slow = make({ verdict: "deny", reason: "ion couldn't decide in time", decided: false });
    await slow.open("turn_1", { url: "https://x.test/mcp", key: "k" }, { http: true });
    expect((await slow.gate("turn_1", call("search"), "x")).reason).toBe(
      "ion couldn't decide, so I'll start a chat",
    );
    const unsure = make({ verdict: "unsure", reason: "can't tell" });
    await unsure.open("turn_1", { url: "https://x.test/mcp", key: "k" }, { http: true });
    await unsure.gate("turn_1", call("search"), "x");
    expect(told).toEqual(["search"]);
  });
});
