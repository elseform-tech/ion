import { MEMORY_TYPES, type MemoryInfo, type MemoryScope, type MemoryType } from "@ion/schema";
import { ScopedMemory } from "../memory/scoped.js";
import type { Handlers } from "./commands.js";
import { UserError } from "./errors.js";

const BOTH = ["chats", "ions"] as const;
const scopeKey = (s: MemoryScope) => (s === "you" ? "you" : `project:${s.projectId}`);
const openTodo = (m: MemoryInfo) => m.type === "todo" && m.status === "open";
/** Open to-dos first, then the latest. */
const byOrder = (a: MemoryInfo, b: MemoryInfo) =>
  Number(openTodo(b)) - Number(openTodo(a)) || b.writtenAt.localeCompare(a.writtenAt);

function typeOf(t: unknown): MemoryType | undefined {
  if (t === undefined) return undefined;
  if (!MEMORY_TYPES.includes(t as MemoryType)) throw new UserError(`Pick a type: ${MEMORY_TYPES.join(", ")}`);
  return t as MemoryType;
}

/** Your memory files: list, read, search, forget, and where the folder is (you see and change everything). */
export const memoryHandlers: Pick<
  Handlers,
  "memory.list" | "memory.read" | "memory.search" | "memory.forget" | "memory.keep" | "memory.folder"
> = {
  "memory.list": (a, ctx) => {
    const type = typeOf(a.type);
    return ctx.memory
      .list(a.projectId ?? null, [...BOTH])
      .filter((m) => (!type || m.type === type) && (!a.open || openTodo(m)))
      .sort(byOrder);
  },
  "memory.read": (a, ctx) => {
    const f = new ScopedMemory(ctx.memory, { kind: "you" }).read(String(a.name ?? ""));
    const { name, description, type, see, status, due, suggested } = f.header;
    const todo = {
      ...(status ? { status } : {}),
      ...(due ? { due } : {}),
      ...(suggested ? { suggested } : {}),
    };
    return {
      path: f.path,
      scope: scopeKey(f.scope),
      name,
      description,
      type,
      see,
      ...todo,
      text: f.text,
      hash: f.hash,
    };
  },
  "memory.search": (a, ctx) => {
    const byPath = new Map(ctx.memory.list(a.projectId ?? null, [...BOTH]).map((m) => [m.memoryId, m]));
    const found = new ScopedMemory(ctx.memory, { kind: "you" }).search(String(a.q ?? ""), 1000);
    return found.flatMap((r) => byPath.get(r.path) ?? []).slice(0, 20);
  },
  "memory.forget": (a, ctx) => {
    new ScopedMemory(ctx.memory, { kind: "you" }).forget(String(a.memoryId ?? ""));
    return { ok: true as const };
  },
  "memory.keep": (a, ctx) => ({
    path: new ScopedMemory(ctx.memory, { kind: "you" }).keep(String(a.path ?? "")),
  }),
  "memory.folder": (_a, ctx) => ({ path: ctx.memory.root }),
};
