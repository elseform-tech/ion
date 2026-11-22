import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MEMORY_SEE, MEMORY_TEXT_MAX, MEMORY_TYPES, type MemoryType } from "@ion/schema";
import { z } from "zod";
import { UserError } from "../api/errors.js";
import { wrapData } from "../context/index.js";
import type { MemoryFiles } from "../memory/index.js";
import { dayOf } from "../notify/clock.js";
import { type Caller, lineOf, type MemoryWrite, ScopedMemory } from "../memory/scoped.js";
import type { MemoryRow } from "../views/memory.js";
import type { Grants } from "./grants.js";
import { guard, ok } from "./result.js";

/** How many changes a run or a turn may make (`id`), what it's told past that, and when it may make none. */
export type WriteLimit = { id: string; max: number; tooMany: string; refuse?: () => void };

type Deps = { memory: MemoryFiles; grants: Grants };

const lines = (source: string, rows: MemoryRow[]) => ok(wrapData(source, rows.map(lineOf).join("\n")));

/** What a scope means to this caller, for the write tool's description. */
const scopeHelp = (c: Caller) =>
  c.kind === "chat"
    ? '"project" (this project), or "you" for the user\'s preferences'
    : '"you" (the user), or a project\'s id';

/** A to-do's day, with today's (local) so "Friday" can be worked out. */
const dueHelp = (now: Date) =>
  `A to-do's day, YYYY-MM-DD; today is ${dayOf(now)}, a ${now.toLocaleDateString("en-US", { weekday: "long" })}`;

/**
 * ion's memory tools for a chat's run or an ion's turn: an index, search, reading a file, and writing or forgetting
 * one, each only over what the caller may see and write. Everything they return is labelled as data.
 */
export function registerMemoryTools(server: McpServer, caller: Caller, d: Deps, limit: WriteLimit): void {
  const m = new ScopedMemory(d.memory, caller);
  findTools(server, m);
  // Counted only when it goes through: a refused change doesn't use one up.
  const counted = <T>(change: () => T): T => {
    limit.refuse?.();
    if (d.grants.noteWrite(limit.id) > limit.max) {
      d.grants.noteWrite(limit.id, -1);
      throw new UserError(limit.tooMany);
    }
    try {
      return change();
    } catch (e) {
      d.grants.noteWrite(limit.id, -1);
      throw e;
    }
  };
  server.registerTool(
    "memory_write",
    {
      description:
        "Keep something for later as a small file, one topic each: a new one needs name, description, type and text. To update one, memory_read it, pass its hash as expect, and give only what changes.",
      inputSchema: {
        scope: z.string().min(1).max(64).describe(scopeHelp(caller)),
        name: z.string().min(1).max(80).optional(),
        description: z.string().min(1).max(160).optional().describe("One line: what the index shows"),
        type: z.enum(MEMORY_TYPES).optional(),
        text: z.string().min(1).max(MEMORY_TEXT_MAX).optional(),
        see: z.enum(MEMORY_SEE).optional(),
        status: z.enum(["open", "done"]).optional(),
        due: z.string().max(10).optional().describe(dueHelp(new Date())),
        expect: z.string().max(64).optional(),
        path: z.string().max(200).optional(),
      },
    },
    guard((w: MemoryWrite) => {
      const f = counted(() => m.write(w));
      return ok(`Saved ${f.path}${f.header.suggested ? " as a suggestion" : ""}`);
    }),
  );
  server.registerTool(
    "memory_forget",
    {
      description: "Delete a memory file: memory_read it first and pass its hash as expect.",
      inputSchema: { name: z.string().min(1).max(200), expect: z.string().min(1).max(64) },
    },
    guard(({ name, expect }: { name: string; expect: string }) =>
      ok(`Forgot ${counted(() => m.forget(name, expect))}`),
    ),
  );
}

function findTools(server: McpServer, m: ScopedMemory): void {
  server.registerTool(
    "memory_index",
    {
      description:
        "Every memory file you may see, one line each (open to-dos first, then the latest): path, name, description, type, whose.",
      inputSchema: { type: z.enum(MEMORY_TYPES).optional(), status: z.enum(["open", "done"]).optional() },
    },
    guard((o: { type?: MemoryType; status?: "open" | "done" }) => lines("memory index", m.index(o))),
  );
  server.registerTool(
    "memory_search",
    {
      description: "Search memory files for words, best match first. At most 20.",
      inputSchema: { q: z.string().min(1).max(500) },
    },
    guard(({ q }: { q: string }) => lines("memory search", m.search(q))),
  );
  server.registerTool(
    "memory_read",
    {
      description: "A memory file's text, and its hash (for memory_write's expect). By its path or its name.",
      inputSchema: {
        name: z.string().min(1).max(200).optional(),
        path: z.string().min(1).max(200).optional(),
      },
    },
    guard(({ name, path }: { name?: string; path?: string }) => {
      if (!(path ?? name)) throw new UserError("Give a name or a path");
      return ok(m.readText((path ?? name)!));
    }),
  );
}
