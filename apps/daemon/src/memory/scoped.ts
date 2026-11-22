import { MEMORY_PATH, type MemoryBy, type MemoryScope, type MemorySee, type MemoryType } from "@ion/schema";
import { UserError } from "../api/errors.js";
import { wrapData } from "../context/index.js";
import type { MemoryRow } from "../views/memory.js";
import { type DreamPass, dreamCreate, dreamForget, dreamUpdate } from "./dream-rules.js";
import { slugOf } from "./files.js";
import type { MemoryFile, MemoryFiles } from "./index.js";

/**
 * Who's asking: a chat's run (its project), an ion over the projects it may see (ion chief: those shared with it; a
 * project's ion: its own), or you (everything).
 */
export type Caller =
  | { kind: "chat"; projectId: string; chatId: string; runId: string }
  | { kind: "ion"; ionId: string; projects: string[]; dream?: DreamPass }
  | { kind: "you" };

/** What a write gives: where ("you", "project": the caller's own, or a project's id), the header and the text. */
export type MemoryWrite = {
  scope: string;
  /** A new file needs all four; an update changes only what it gives. */
  name?: string;
  description?: string;
  type?: MemoryType;
  text?: string;
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
const ONLY_YOU_CLOSE = "Only you close a to-do";
type TodoFields = { type: MemoryType; status?: "open" | "done"; due?: string };
const NEW_NEEDS = "A new memory needs a name, a description, a type and a text";
/** Each line with its control characters (a bell, a stray escape) gone; line breaks and tabs kept. */
const clean = (t: string) => t.replace(/[^\P{Cc}\n\t]/gu, "");
const quoted = (s: string) => JSON.stringify(clean(s));
const scopeName = (s: MemoryScope) => (s === "you" ? "yours" : s.projectId);
const sameScope = (a: MemoryScope, b: MemoryScope) =>
  a === "you" || b === "you" ? a === b : a.projectId === b.projectId;
const folderOf = (s: MemoryScope) => (s === "you" ? "you" : `projects/${s.projectId}`);
/** Who made the last change, in a word. */
const byWord = (by: MemoryBy) => {
  if (by === "you") return "by you";
  return "ion" in by ? "by ion" : "by chat";
};
/** The fields an update gives (the rest stay as the file has them). */
const given = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/** A file as one index line: path, name, description, type (a to-do's status and date), whose. */
export function lineOf(r: MemoryRow): string {
  const kind: string[] = [r.type];
  if (r.type === "todo") kind.push(r.status ?? "open", ...(r.due ? [`due ${r.due}`] : []));
  if (r.suggested) kind.push("suggested");
  kind.push(scopeName(r.scope), byWord(r.by));
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

/**
 * An ion's index for a turn: always in a new session; in a resumed one only when it changed since that ion's session
 * was last given it (`sent`, by ion).
 */
export function ionIndex(
  memory: MemoryFiles | undefined,
  caller: Caller & { kind: "ion" },
  o: IonIndexOpts,
): string {
  const i = memory && new ScopedMemory(memory, caller).indexBlock();
  const key = i ? `${i.source}\n${i.body}` : "";
  if (o.resumed && o.sent.get(caller.ionId) === key) return "";
  o.sent.set(caller.ionId, key);
  return i ? wrapData(i.source, i.body) + "\n\n" : "";
}
type IonIndexOpts = { resumed: boolean; sent: Map<string, string> };

/**
 * A name written as a file name ("tidy-the-shop-readme") as words ("Tidy the shop readme"): reminders and "Mark
 * done?" say a file's name (Task 5, 2026-11-22: agents named files like file names).
 */
const asWords = (name: string) =>
  /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(name)
    ? name.replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase())
    : name;

/** A real day, written YYYY-MM-DD. */
function isDay(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const t = new Date(y, m - 1, d);
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d;
}

/** A to-do is open unless it says; other files keep a status only when given one. */
function statusOf(type: MemoryType, status?: "open" | "done"): { status?: "open" | "done" } {
  if (type === "todo") return { status: status ?? "open" };
  return status ? { status } : {};
}

/**
 * A file that becomes a to-do is open unless it says; one that stops being one drops its status and date (Task 2
 * re-review, 2026-11-22).
 */
function asTodoOrNot<H extends { type: MemoryType; status?: "open" | "done"; due?: string }>(
  was: H,
  h: H,
): H {
  if (h.type === "todo") return h.status ? h : { ...h, status: "open" };
  if (was.type !== "todo") return h;
  const rest = { ...h };
  delete rest.status;
  delete rest.due;
  return rest;
}

type Sight = { scopes: MemoryScope[] | "all"; see: MemorySee[]; suggestedFor?: string };

/** What a caller may see: which scopes, which files there (`see`), and (a chat) only its own project's suggestions. */
function sightOf(c: Caller): Sight {
  if (c.kind === "you") return { scopes: "all", see: ["chats", "ions"] };
  if (c.kind === "chat")
    return { scopes: ["you", { projectId: c.projectId }], see: ["chats"], suggestedFor: c.projectId };
  // ion's dream: one project's files (and yours, which its chats and ion see) or yours alone; a chats pass, chats files.
  if (c.dream) {
    const scopes: MemoryScope[] = c.dream.project ? ["you", { projectId: c.dream.project }] : ["you"];
    return { scopes, see: c.dream.see === "chats" ? ["chats"] : ["chats", "ions"] };
  }
  return { scopes: ["you", ...c.projects.map((projectId) => ({ projectId }))], see: ["chats", "ions"] };
}

/**
 * ion's memory as one caller has it: only the files it may see (the rest don't exist for it, not even their names),
 * and only the writes it may make. Every MCP tool and the up-front index go through this.
 */
export class ScopedMemory {
  private readonly sight: Sight;
  /** ion's dream's pass: what it may never touch, and which files this pass sees and changes (dream-rules.ts). */
  private readonly dream: DreamPass | undefined;

  constructor(
    private readonly memory: MemoryFiles,
    private readonly caller: Caller,
  ) {
    this.sight = sightOf(caller);
    this.dream = caller.kind === "ion" ? caller.dream : undefined;
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
    const i = this.indexBlock();
    return i ? wrapData(i.source, i.body) + "\n\n" : "";
  }

  /** The up-front index's lines and label; null when there's no memory. */
  indexBlock(): { source: string; body: string } | null {
    const rows = this.index({ limit: UP_FRONT + 1 });
    if (!rows.length) return null;
    const more = rows.length > UP_FRONT ? ", more with memory_search" : "";
    return { source: "ion's memory index" + more, body: rows.slice(0, UP_FRONT).map(lineOf).join("\n") };
  }

  /** A file the caller may see, read from disk, by its path, its file name or its name. */
  read(name: string): MemoryFile {
    const row = this.resolve(name);
    const r = this.memory.read(row.path);
    if (!r.ok) throw new UserError(r.gone ? NONE : r.problem);
    // Changed by hand (ions only, another project's suggestion) and not indexed yet: still not for it.
    if (!this.allows(r.file.header)) throw new UserError(NONE);
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
  write(given: MemoryWrite): MemoryFile {
    // Only an agent's names: yours stay as you typed them (task review, 2026-11-22).
    const agent = this.caller.kind !== "you" && given.name;
    const w = agent ? { ...given, name: asWords(given.name!) } : given;
    if (w.due !== undefined && !isDay(w.due)) throw new UserError("Give the date as YYYY-MM-DD");
    const scope = this.scopeOf(w.scope);
    return w.expect === undefined ? this.create(scope, w) : this.update(scope, w, w.expect);
  }

  /**
   * Deletes a file the caller may see and write, only as it was read (`expect`; you: as it is); `into`: the file ion's
   * dream merged it into.
   */
  forget(name: string, expect?: string, into?: string): string {
    const row = this.resolve(name);
    this.mayWrite(row.scope, row.type);
    if (this.dream)
      dreamForget(this.memory, this.dream, row, into === undefined ? undefined : this.resolve(into));
    const c = this.caller;
    // A chat forgets only your files its own project suggested.
    if (c.kind === "chat" && row.scope === "you" && row.suggested !== c.projectId)
      throw new UserError("A chat can't forget your files");
    if (c.kind !== "you" && expect === undefined) throw new UserError("Read it first");
    // Forgetting an open to-do closes it too (task review, 2026-11-22).
    if (c.kind !== "you" && row.type === "todo" && row.status !== "done") throw new UserError(ONLY_YOU_CLOSE);
    this.memory.forget(row.path, this.by(), expect, into && this.resolve(into).path);
    return row.path;
  }

  /** You keep a chat's suggestion: every project's chats see it from now on. */
  keep(name: string): string {
    const f = this.read(name);
    if (!f.header.suggested) return f.path;
    const header = { ...f.header };
    delete header.suggested;
    const w = { scope: f.scope, slug: f.slug, header, text: f.text, expectHash: f.hash, by: this.by() };
    return this.memory.write(w).path;
  }

  /** A new file: never next to one with its name, seen or not (a "-2" would say a hidden one is there). */
  private create(scope: MemoryScope, w: MemoryWrite): MemoryFile {
    const { name, description, type, text } = w;
    if (!name || !description || !type || !text) throw new UserError(NEW_NEEDS);
    this.mayWrite(scope, type);
    const c = this.caller;
    const chatsYours = c.kind === "chat" && scope === "you";
    if (chatsYours && w.see) throw new UserError("A chat can't choose who sees your files");
    const see = this.dream ? dreamCreate(this.dream, scope, type, w.see) : w.see;
    this.mayClose({ type }, { type, ...statusOf(type, w.status) });
    this.noClash(scope, name);
    const header = {
      ...{ name, description, type, ...statusOf(type, w.status) },
      ...given({ see, due: w.due }),
      // A chat's preference waits for you to keep it (security review, 2026-11-22).
      ...(c.kind === "chat" && chatsYours ? { suggested: c.projectId } : {}),
    };
    return this.memory.write({ scope, header, text, by: this.by() });
  }

  /** An update: the file's header on disk, with only the fields given changed. */
  private update(scope: MemoryScope, w: MemoryWrite, expectHash: string): MemoryFile {
    const was = this.named(w.path ?? w.name ?? "", scope);
    if (!was) throw new UserError(NONE);
    const disk = this.read(was.path);
    const { name, description, type, see, status, due } = w;
    const header = asTodoOrNot(disk.header, {
      ...disk.header,
      ...given({ name, description, type, see, status, due }),
    });
    this.mayWrite(scope, disk.header.type);
    this.mayWrite(scope, header.type);
    if (this.dream) dreamUpdate(this.memory, this.dream, { ...disk.header, path: disk.path, scope }, header);
    this.mayChange(scope, disk.header, header.see);
    this.mayClose(disk.header, header);
    const text = w.text ?? disk.text;
    return this.memory.write({ scope, slug: was.slug, header, text, expectHash, by: this.by() });
  }

  /**
   * Only you close a to-do: a chat or an ion never marks one done, retypes one away from a to-do, or clears its
   * status or date (live, Grok, and task review, 2026-11-22). They offer "Mark done?" instead.
   */
  private mayClose(old: TodoFields, next: TodoFields): void {
    if (this.caller.kind === "you") return;
    const closes =
      old.type === "todo"
        ? next.type !== "todo" ||
          (next.status === "done" && old.status !== "done") ||
          (!!old.due && !next.due)
        : next.type === "todo" && next.status === "done";
    if (closes) throw new UserError(ONLY_YOU_CLOSE);
  }

  /** A chat changes only your files its project suggested; who sees a file changes only by you (or wider, never). */
  private mayChange(scope: MemoryScope, old: MemoryFile["header"], see: MemorySee): void {
    const c = this.caller;
    if (c.kind === "you") return;
    if (c.kind === "chat" && scope === "you" && old.suggested !== c.projectId)
      throw new UserError("A chat can't change your shared files");
    if (old.see === see) return;
    if (c.kind === "chat") throw new UserError("A chat can't change who sees a file");
    if (see === "chats") throw new UserError("Only the user shares a file with chats");
  }

  /** A file with this name (its slug) in that scope, whether this caller sees it or not, is refused alike. */
  private noClash(scope: MemoryScope, name: string): void {
    const path = `${folderOf(scope)}/${slugOf(name)}.md`;
    const disk = this.memory.read(path);
    if (this.named(name, scope) || this.memory.row(path) || disk.ok || !disk.gone)
      throw new UserError(
        `There's already a memory named ${quoted(name)}: read it, then update it with expect`,
      );
  }

  /** The caller may see a file with this header (as read from disk). */
  private allows(h: { see: MemorySee; suggested?: string }): boolean {
    const s = this.sight;
    return s.see.includes(h.see) && (!h.suggested || !s.suggestedFor || h.suggested === s.suggestedFor);
  }

  /** The caller may see this indexed file. */
  private visible(r: MemoryRow): boolean {
    const s = this.sight;
    const inScope = s.scopes === "all" || s.scopes.some((x) => sameScope(x, r.scope));
    return inScope && this.allows({ see: r.see, ...(r.suggested ? { suggested: r.suggested } : {}) });
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
    if (MEMORY_PATH.test(key)) {
      const row = this.memory.row(key);
      return row && this.visible(row) ? [row] : [];
    }
    const all = this.memory.find({ ...this.sight, limit: Number.MAX_SAFE_INTEGER });
    const lower = key.toLowerCase().replace(/\.md$/, "");
    const slug = slugOf(lower);
    return all.filter((r) => r.slug === slug || r.name.toLowerCase() === lower);
  }
}
