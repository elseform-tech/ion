import { join } from "node:path";
import {
  EV,
  MEMORY_PATH,
  MEMORY_TEXT_MAX,
  type MemoryBy,
  type MemoryInfo,
  type MemoryScope,
  type MemorySee,
} from "@ion/schema";
import { UserError } from "../api/errors.js";
import type { Db, EventStore } from "../store/index.js";
import { memoryView } from "../views/memory.js";
import { moveNotes } from "./migrate.js";
import { watchMemory } from "./watch.js";
import {
  type Before,
  type FileRead,
  type FileWrite,
  type MemoryFile,
  type MemoryFolder,
  memoryFolder,
} from "./files.js";

export type { FileRead, MemoryFile } from "./files.js";

const capped = (b: Before): Before => ({ hash: b.hash, text: b.text.slice(0, MEMORY_TEXT_MAX) });
const scopeOf = (key: string): MemoryScope => (key === "you" ? "you" : { projectId: key });

/**
 * ion's memory: a folder of small Markdown files, yours and each project's. The files are the truth; every change
 * (ion's, a chat's, an ion's, or yours in an editor) is an event, and the index (views/memory.ts) follows.
 */
export class MemoryFiles {
  private readonly folder: MemoryFolder;
  /** Files that can't be read now, each with its one plain line (their last good version stays indexed). */
  private readonly broken = new Map<string, string>();

  constructor(private readonly o: { root: string; store: EventStore; db: Db }) {
    this.folder = memoryFolder(o.root);
  }

  get root(): string {
    return this.o.root;
  }

  read(path: string): FileRead {
    return this.folder.read(path);
  }

  /** Writes a file (new, or over the version read: `expectHash`), logs who did it, and indexes it. */
  write(w: FileWrite & { by: MemoryBy }): MemoryFile {
    const { file, before } = this.folder.write(w);
    this.log(file, w.by, before);
    return file;
  }

  /** Deletes a file and logs it, with its text before. */
  forget(path: string, by: MemoryBy): void {
    if (!MEMORY_PATH.test(path)) throw new UserError(`Unknown memory: ${path}`);
    const row = memoryView.get(this.o.db, path);
    const gone = this.folder.remove(path);
    if (!row && !gone) throw new UserError(`Unknown memory: ${path}`);
    this.broken.delete(path);
    const before = gone ?? { hash: row!.hash, text: row!.text };
    this.append(EV.memoryForgotten, { path, by, before: capped(before) });
  }

  /**
   * Brings one file's index up to date with the disk: a change ion didn't make is logged as `by` (yours, from an
   * editor); a file gone is forgotten; a broken one keeps its last good version and is reported.
   */
  sync(path: string, by: MemoryBy = "you"): void {
    const r = this.folder.read(path);
    const row = memoryView.get(this.o.db, path);
    if (!r.ok && !r.gone) {
      this.broken.set(path, r.problem);
      return;
    }
    this.broken.delete(path);
    if (!r.ok) {
      if (row) this.append(EV.memoryForgotten, { path, by, before: capped(row) });
      return;
    }
    if (row?.hash === r.file.hash) memoryView.index(this.o.db, path, r.file.text);
    else this.log(r.file, by, row ? { hash: row.hash, text: row.text } : undefined);
  }

  /** Every file on disk and in the index, synced (at start, and when the watch can't say what changed). */
  reindex(): void {
    for (const path of new Set([...this.folder.list(), ...memoryView.paths(this.o.db)])) this.sync(path);
  }

  /** Every file's path on disk. */
  paths(): string[] {
    return this.folder.list();
  }

  /** Watches the folder for your own edits; returns a stop. */
  watch(): () => void {
    return watchMemory(this);
  }

  /** The index has this file. */
  indexed(path: string): boolean {
    return memoryView.get(this.o.db, path) !== undefined;
  }

  /** Files that can't be read, one plain line each. */
  problems(): string[] {
    return [...this.broken.values()].sort();
  }

  /** Yours and one project's (or all), with each broken file's line. */
  list(projectId: string | null, see: MemorySee[]): MemoryInfo[] {
    return memoryView.list(this.o.db, projectId, see).map((m) => {
      const problem = this.broken.get(m.memoryId);
      return problem ? { ...m, problem } : m;
    });
  }

  /** A short note as its own file (the name is its start, the description its first line). */
  note(
    scope: MemoryScope | string,
    text: string,
    by: MemoryBy,
    extra: { from?: string; see?: "chats" | "ions" } = {},
  ): string {
    const s = typeof scope === "string" ? scopeOf(scope) : scope;
    const t = text.trim();
    if (!t) throw new UserError("A memory can't be empty");
    const name = t.replace(/\s+/g, " ").slice(0, 60).trimEnd();
    const description = t.split("\n")[0]!.trim().slice(0, 160).trimEnd();
    return this.write({ scope: s, header: { name, description, type: "fact", ...extra }, text: t, by }).path;
  }

  private log(file: MemoryFile, by: MemoryBy, before?: Before): void {
    const { path, scope, slug, header, hash } = file;
    const data = { path, scope, slug, header, hash, by, ...(before ? { before: capped(before) } : {}) };
    this.append(EV.memoryWritten, data);
    memoryView.index(this.o.db, path, file.text);
  }

  private append(
    type: typeof EV.memoryWritten | typeof EV.memoryForgotten,
    data: Record<string, unknown>,
  ): void {
    this.o.store.append({ chatId: null, runId: null, origin: "daemon", type, data });
  }
}

/**
 * ion's memory folder (in its data folder, where chats' agents can't reach it): old notes moved to files once, then
 * the index brought up to date with the files (your edits while ion was stopped are logged as yours).
 */
export function openMemory(dataDir: string, store: EventStore, db: Db): MemoryFiles {
  const memory = new MemoryFiles({ root: join(dataDir, "memory"), store, db });
  moveNotes(memory, store);
  memory.reindex();
  return memory;
}
