import { loadUserConfig } from "@ion/config";
import {
  MEMORY_SEE,
  MEMORY_TYPES,
  type MemoryBy,
  type MemoryChangeInfo,
  type MemoryInfo,
  type MemoryScope,
  type MemorySee,
  type MemoryType,
} from "@ion/schema";
import { restoreForgotten, tidied } from "../memory/dream.js";
import { ScopedMemory } from "../memory/scoped.js";
import { addTodo, closeTodo } from "../memory/todos.js";
import type { Db } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import type { Handlers } from "./commands.js";
import { UserError } from "./errors.js";

const BOTH = ["chats", "ions"] as const;
const scopeKey = (s: MemoryScope) => (s === "you" ? "you" : `project:${s.projectId}`);
/** A scope's key in the list ("you", or "project:<id>"), from "you" or a project's id. */
const keyOf = (s: string) => scopeKey(s === "you" ? "you" : { projectId: s });
const openTodo = (m: MemoryInfo) => m.type === "todo" && m.status === "open";
/** Open to-dos first, then the latest. */
const byOrder = (a: MemoryInfo, b: MemoryInfo) =>
  Number(openTodo(b)) - Number(openTodo(a)) || b.writtenAt.localeCompare(a.writtenAt);

function typeOf(t: unknown): MemoryType | undefined {
  if (t === undefined) return undefined;
  if (!MEMORY_TYPES.includes(t as MemoryType)) throw new UserError(`Pick a type: ${MEMORY_TYPES.join(", ")}`);
  return t as MemoryType;
}

/** Who changed it, as the list says: "you", a chat's id, or "ion:<id>". */
const sourceOf = (by: MemoryBy) => {
  if (by === "you") return "you";
  return "ion" in by ? `ion:${by.ion}` : by.chatId;
};

/** Each chat's title by its id (for "changed by" a chat). */
const titles = (db: Db) => new Map(chatsView.list(db).map((c) => [c.chatId, c.title]));

/** A file as listed, with the title of the chat that changed it last. */
function titled<T extends { source: string }>(m: T, t: Map<string, string>): T & { sourceTitle?: string } {
  const title = t.get(m.source);
  return title ? { ...m, sourceTitle: title } : m;
}

function seeOf(s: unknown): MemorySee | undefined {
  if (s === undefined) return undefined;
  if (!MEMORY_SEE.includes(s as MemorySee)) throw new UserError(`Pick who sees it: ${MEMORY_SEE.join(", ")}`);
  return s as MemorySee;
}

/** Each change to a file, newest first, with the text it left (the next change's text before, or the file now). */
function historyOf(ctx: Parameters<Handlers["memory.history"]>[1], path: string): MemoryChangeInfo[] {
  const changes = ctx.memory.history(path);
  const now = ctx.memory.read(path);
  const t = titles(ctx.db);
  const nowText = now.ok ? now.file.text : undefined;
  const out = changes.map((c, i): MemoryChangeInfo => {
    const next = changes[i + 1];
    const left = next ? next.before?.text : nowText;
    const text = c.kind === "written" && left !== undefined ? { text: left } : {};
    return titled({ at: c.at, kind: c.kind, source: sourceOf(c.by), ...text }, t);
  });
  return out.reverse();
}

/**
 * Restoring, what the dream did, and dreaming now are yours only: a chat's agent (a run's key) is refused here too,
 * not only by the connection (security review, 2026-11-22).
 */
function yoursOnly(ctx: { caller?: unknown }): undefined {
  if (ctx.caller) throw new UserError("A chat's agent can't do that");
  return undefined;
}

/** Your memory files: list, read, search, forget, and where the folder is (you see and change everything). */
export const memoryHandlers: Pick<
  Handlers,
  | "memory.list"
  | "memory.read"
  | "memory.search"
  | "memory.forget"
  | "memory.keep"
  | "memory.history"
  | "memory.write"
  | "memory.folder"
  | "memory.restore"
  | "memory.tidied"
  | "memory.dream"
> = {
  "memory.list": (a, ctx) => {
    const type = typeOf(a.type);
    const t = titles(ctx.db);
    return ctx.memory
      .list(a.projectId ?? null, [...BOTH])
      .filter((m) => (!type || m.type === type) && (!a.open || openTodo(m)))
      .sort(byOrder)
      .map((m) => titled(m, t));
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
    const t = titles(ctx.db);
    // One scope's files, before the best 20 are taken (task review, 2026-11-22).
    const key = a.scope === undefined ? null : keyOf(a.scope);
    return found
      .flatMap((r) => byPath.get(r.path) ?? [])
      .filter((m) => key === null || m.scope === key)
      .slice(0, 20)
      .map((m) => titled(m, t));
  },
  "memory.forget": (a, ctx) => {
    new ScopedMemory(ctx.memory, { kind: "you" }).forget(String(a.memoryId ?? ""));
    return { ok: true as const };
  },
  "memory.keep": (a, ctx) => ({
    path: new ScopedMemory(ctx.memory, { kind: "you" }).keep(String(a.path ?? "")),
  }),
  "memory.history": (a, ctx) => historyOf(ctx, String(a.path ?? "")),
  "memory.write": (a, ctx) => {
    const m = new ScopedMemory(ctx.memory, { kind: "you" });
    const f = m.read(String(a.path ?? ""));
    const see = seeOf(a.see);
    const text = a.text === undefined ? {} : { text: String(a.text) };
    const scope = f.scope === "you" ? "you" : f.scope.projectId;
    const w = m.write({
      scope,
      path: f.path,
      expect: String(a.expect ?? ""),
      ...text,
      ...(see ? { see } : {}),
    });
    return titled(infoOf(ctx, w.path), titles(ctx.db));
  },
  "memory.folder": (_a, ctx) => ({ path: ctx.memory.root, problems: ctx.memory.problems() }),
  "memory.restore": (a, ctx) =>
    yoursOnly(ctx) ??
    titled(infoOf(ctx, restoreForgotten(ctx.memory, String(a.path ?? "")).path), titles(ctx.db)),
  "memory.tidied": (_a, ctx) => yoursOnly(ctx) ?? tidied(ctx.store, ctx.memory),
  "memory.dream": async (_a, ctx) => {
    yoursOnly(ctx);
    if (!ctx.dreams) throw new UserError("ion can't tidy memory here");
    await ctx.dreams.now();
    return tidied(ctx.store, ctx.memory);
  },
};

/** A file as listed, by its path. */
const infoOf = (ctx: Parameters<Handlers["memory.list"]>[1], path: string): MemoryInfo => {
  const m = ctx.memory.list(null, [...BOTH]).find((x) => x.memoryId === path);
  if (!m) throw new UserError(`Unknown memory: ${path}`);
  return m;
};

/** Your to-dos: add one (yours or a project's), or mark one done. */
export const todoHandlers: Pick<Handlers, "todo.add" | "todo.done"> = {
  "todo.add": (a, ctx) => {
    const projectId = a.projectId ? String(a.projectId) : undefined;
    if (projectId && !loadUserConfig(ctx.configFile).config.projects.some((p) => p.id === projectId))
      throw new UserError(`Unknown project: ${projectId}`);
    const f = addTodo(ctx.memory, {
      text: String(a.text ?? ""),
      ...(projectId ? { projectId } : {}),
      ...(a.due ? { due: String(a.due) } : {}),
    });
    return infoOf(ctx, f.path);
  },
  "todo.done": (a, ctx) => infoOf(ctx, closeTodo(ctx.memory, String(a.name ?? "")).path),
};
