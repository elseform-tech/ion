import { MEMORY_PATH, type MemoryBy, type MemoryScope, type MemorySee, type MemoryType } from "@ion/schema";
import { UserError } from "../api/errors.js";
import { wrapData } from "../context/index.js";
import type { MemoryRow } from "../views/memory.js";
import { slugOf } from "./files.js";
import type { MemoryFile, MemoryFiles } from "./index.js";

/**
 * Who's asking: a chat's run (its project), an ion over the projects it may see (ion chief: those shared with it; a
 * project's ion: its own), or you (everything).
 */
export type Caller =
  | { kind: "chat"; projectId: string; chatId: string; runId: string }
  | { kind: "ion"; ionId: string; projects: string[] }
  | { kind: "you" };

/** What a write gives: where ("you", "project": the caller's own, or a project's id), the header and the text. */
export type MemoryWrite = {
  scope: string;
  name: string;
  description: string;
  type: MemoryType;
  text: string;
  see?: MemorySee;
  status?: "open" | "done";
  due?: string;
  /** The hash memory_read gave: the file is updated only if it's still that. */
  expect?: string;
  /** The file to update (else the one with this name in that scope). */
  path?: string;
};

const INDEX_MAX = 200;
const FOUND_MAX = 20;
/** How much of its index a chat's first message (or an ion's turn) starts with. */
const UP_FRONT = 40;

/** One answer for a file that isn't there and one the caller may not see: it doesn't exist for it. */
const NONE = "No such memory";
const CHAT_WRITES = "A chat writes this project's files and your preferences only";
/** Each line with its control characters (a bell, a stray escape) gone; line breaks and tabs kept. */
const clean = (t: string) => t.replace(/[^\P{Cc}\n\t]/gu, "");
const quoted = (s: string) => JSON.stringify(clean(s));
const scopeName = (s: MemoryScope) => (s === "you" ? "yours" : s.projectId);
const sameScope = (a: MemoryScope, b: MemoryScope) =>
  a === "you" || b === "you" ? a === b : a.projectId === b.projectId;

/** A file as one index line: path, name, description, type (a to-do's status and date), whose. */
export function lineOf(r: MemoryRow): string {
  const kind: string[] = [r.type];
  if (r.type === "todo") kind.push(r.status ?? "open", ...(r.due ? [`due ${r.due}`] : []));
  kind.push(scopeName(r.scope));
  return `${r.path} ${quoted(r.name)}: ${quoted(r.description)} (${kind.join(", ")})`;
}

/** The project an ion writes in: "project" is a project's ion's own; else one it may see. */
function ionProject(c: { ionId: string; projects: string[] }, s: string): string {
  if (s !== "project") {
    if (!c.projects.includes(s)) throw new UserError("Unknown project");
    return s;
  }
  if (c.ionId === "chief") throw new UserError("Name the project");
  return c.ionId;
}

/** The index a chat's first message or an ion's turn starts with (nothing without memory). */
export const upFront = (memory: MemoryFiles | undefined, caller: Caller) =>
  memory ? new ScopedMemory(memory, caller).upFront() : "";

/** A to-do is open unless it says; other files keep a status only when given one. */
function statusOf(w: MemoryWrite): { status?: "open" | "done" } {
  if (w.type === "todo") return { status: w.status ?? "open" };
  return w.status ? { status: w.status } : {};
}

/** What a caller may see: which scopes, and which files there (`see`). */
function sightOf(c: Caller): { scopes: MemoryScope[] | "all"; see: MemorySee[] } {
  if (c.kind === "you") return { scopes: "all", see: ["chats", "ions"] };
  if (c.kind === "chat") return { scopes: ["you", { projectId: c.projectId }], see: ["chats"] };
  return { scopes: ["you", ...c.projects.map((projectId) => ({ projectId }))], see: ["chats", "ions"] };
}

/**
 * ion's memory as one caller has it: only the files it may see (the rest don't exist for it, not even their names),
 * and only the writes it may make. Every MCP tool and the up-front index go through this.
 */
export class ScopedMemory {
  private readonly sight: ReturnType<typeof sightOf>;

  constructor(
    private readonly memory: MemoryFiles,
    private readonly caller: Caller,
  ) {
    this.sight = sightOf(caller);
  }

  /** Open to-dos first, then the most recently changed. */
  index(o: { type?: MemoryType; status?: "open" | "done"; limit?: number } = {}): MemoryRow[] {
    return this.memory.find({ ...this.sight, ...o, limit: o.limit ?? INDEX_MAX });
  }

  /** The best matches for some words. */
  search(q: string, limit = FOUND_MAX): MemoryRow[] {
    return this.memory.find({ ...this.sight, q, limit });
  }

  /** A first message's index, as data: at most UP_FRONT lines; nothing when there's no memory. */
  upFront(): string {
    const rows = this.index({ limit: UP_FRONT + 1 });
    if (!rows.length) return "";
    const more = rows.length > UP_FRONT ? ", more with memory_search" : "";
    const body = rows.slice(0, UP_FRONT).map(lineOf).join("\n");
    return wrapData("ion's memory index" + more, body) + "\n\n";
  }

  /** A file the caller may see, read from disk, by its path, its file name or its name. */
  read(name: string): MemoryFile {
    const row = this.resolve(name);
    const r = this.memory.read(row.path);
    if (!r.ok) throw new UserError(r.gone ? NONE : r.problem);
    // Changed by hand to ions only, and not indexed yet: still not for a chat.
    if (!this.sight.see.includes(r.file.header.see)) throw new UserError(NONE);
    return r.file;
  }

  /** A file's text for a model: its path and hash, then its header and text as data. */
  readText(name: string): string {
    const f = this.read(name);
    const h = f.header;
    const head = [
      `name: ${h.name}`,
      `description: ${h.description}`,
      `type: ${h.type}`,
      ...(h.status ? [`status: ${h.status}`] : []),
      ...(h.due ? [`due: ${h.due}`] : []),
    ];
    const body = clean(`${head.join("\n")}\n\n${f.text}`);
    const data = wrapData("memory " + f.path, body);
    return `path: ${f.path}\nhash: ${f.hash}\n${data}`;
  }

  /** Makes a file, or updates one read at `expect`; refused unless this caller may write it there. */
  write(w: MemoryWrite): MemoryFile {
    const scope = this.scopeOf(w.scope);
    this.mayWrite(scope, w.type);
    const header = {
      ...{ name: w.name, description: w.description, type: w.type },
      ...(w.see ? { see: w.see } : {}),
      ...statusOf(w),
      ...(w.due ? { due: w.due } : {}),
    };
    const by = this.by();
    if (w.expect === undefined) {
      const twin = this.named(w.path ?? w.name, scope);
      if (twin) throw new UserError(`There's already ${twin.path}: read it, then update it with expect`);
      return this.memory.write({ scope, header, text: w.text, by });
    }
    const was = this.named(w.path ?? w.name, scope);
    if (!was) throw new UserError(NONE);
    this.mayWrite(scope, was.type);
    return this.memory.write({ scope, slug: was.slug, header, text: w.text, expectHash: w.expect, by });
  }

  /** Deletes a file the caller may see and write, only as it was read (`expect`; you: as it is). */
  forget(name: string, expect?: string): string {
    const row = this.resolve(name);
    this.mayWrite(row.scope, row.type);
    if (this.caller.kind !== "you" && expect === undefined) throw new UserError("Read it first");
    this.memory.forget(row.path, this.by(), expect);
    return row.path;
  }

  /** Who a change is by. */
  private by(): MemoryBy {
    const c = this.caller;
    if (c.kind === "chat") return { chatId: c.chatId, runId: c.runId };
    return c.kind === "ion" ? { ion: c.ionId } : "you";
  }

  /** Where a write goes: "you", "project" (the caller's own project), or a project it may see. */
  private scopeOf(s: string): MemoryScope {
    const c = this.caller;
    if (s === "you" || c.kind === "you") return s === "you" ? "you" : { projectId: s };
    if (c.kind === "chat") {
      if (s !== "project" && s !== c.projectId) throw new UserError(CHAT_WRITES);
      return { projectId: c.projectId };
    }
    return { projectId: ionProject(c, s) };
  }

  /** Chats write their project's files and your preferences; only ion chief (and you) your person files. */
  private mayWrite(scope: MemoryScope, type: MemoryType): void {
    const c = this.caller;
    if (scope !== "you" || c.kind === "you") return;
    if (c.kind === "chat" && type !== "preference") throw new UserError(CHAT_WRITES);
    if (c.kind === "ion" && type === "person" && c.ionId !== "chief")
      throw new UserError("Only ion chief writes your person files");
  }

  /** A file this caller may see, by path, file name or name (ignoring case). */
  private resolve(name: string): MemoryRow {
    const hits = this.matches(name);
    if (hits.length > 1)
      throw new UserError(`Several match: ${hits.map((h) => h.path).join(", ")}; give the path`);
    // You see everything, so your own lookups may say the name.
    if (!hits[0]) throw new UserError(this.caller.kind === "you" ? `Unknown memory: ${name}` : NONE);
    return hits[0];
  }

  /** The file this caller may see in that scope with this path, file name or name, if any. */
  private named(name: string, scope: MemoryScope): MemoryRow | undefined {
    return this.matches(name).find((r) => sameScope(r.scope, scope));
  }

  private matches(name: string): MemoryRow[] {
    const key = name.trim();
    const all = this.memory.find({ ...this.sight, limit: Number.MAX_SAFE_INTEGER });
    if (MEMORY_PATH.test(key)) return all.filter((r) => r.path === key);
    const lower = key.toLowerCase().replace(/\.md$/, "");
    const slug = slugOf(lower);
    return all.filter((r) => r.slug === slug || r.name.toLowerCase() === lower);
  }
}
