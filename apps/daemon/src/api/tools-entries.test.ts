import type { OwnServerInfo, ToolsInfo } from "@ion/schema";
import { describe, expect, it } from "vitest";
import { withOrigins } from "./tools-entries.js";

// Final review, 2026-11-22 (automated review of M3): the first listing of agents' own servers counts them as already
// there only when nothing at all was ever seen; a store that can't be read, or holds other keys but not that first
// listing, marks unseen own servers New (fail closed), never records them as seen.
describe("agents' own servers that are new", () => {
  const server: OwnServerInfo = {
    agent: "claude-code",
    name: "planted",
    transport: "stdio",
    launch: "p",
    match: "m",
  };
  const info = {
    mcp: [],
    hooks: [],
    skills: [],
    own: { agents: {}, servers: [server], plugins: [] },
  } as unknown as ToolsInfo;
  const ctxOf = (state: "empty" | "ok" | "unreadable", keys: string[] = []) => {
    const added: string[] = [];
    const seen = {
      has: (k: string) => keys.includes(k),
      add: (ks: string[]) => void added.push(...ks),
      state: () => state,
    };
    return { ctx: { seen, added: { find: () => null }, db: {} } as never, added };
  };
  const newOf = (c: { ctx: never }) => withOrigins(c.ctx, info, []).own.servers[0]?.new;

  it("counts them as there on a first listing of an empty store", () => {
    const c = ctxOf("empty");
    expect(newOf(c)).toBeUndefined();
    expect(c.added).toContain("own:claude-code:planted:m");
  });

  it("marks them New, and records nothing, when the store can't be read", () => {
    const c = ctxOf("unreadable");
    expect(newOf(c)).toBe(true);
    expect(c.added).toEqual([]);
  });

  it("marks them New when the store holds other keys but not the first listing", () => {
    expect(newOf(ctxOf("ok", ["mcp:x:y"]))).toBe(true);
  });
});
