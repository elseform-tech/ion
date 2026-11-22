import { chmodSync, lstatSync, mkdirSync } from "node:fs";
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
import { type MemoryQuery, type MemoryRow, memoryView } from "../views/memory.js";
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
export { upFront } from "./scoped.js";

/** A note's `from:` (the old note it was moved from) and `see`; `overCap`: moving old notes only. */
type NoteOptions = { from?: string; see?: "chats" | "ions"; overCap?: true };

const capped = (b: Before): Before => ({ hash: b.hash, text: b.text.slice(0, MEMORY_TEXT_MAX) });
/** Each line with its control characters (a stray \r, a bell) as spaces. */
const cleanLines = (t: string) => t.split("\n").map((l) => l.replace(/\p{Cc}/gu, " "));

/**
 * ion's memory: a folder of small Markdown files, yours and each project's. The files are the truth; every change
 * (ion's, a chat's, an ion's, or yours in an editor) is an event, and the index (views/memory.ts) follows.
 */
export class MemoryFiles {
  private readonly folder: MemoryFolder;
  /** Files that can't be read now, each with its one plain line (their last good version stays indexed). */
  private readonly broken = new Map<string, string>();
  /** Files ion can't take for memory files by their names, one line each (found by `reindex`). */
  private misnamed: string[] = [];

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
  forget(path: string, by: MemoryBy, expectHash?: string): void {
    if (!MEMORY_PATH.test(path)) throw new UserError(`Unknown memory: ${path}`);
    const row = memoryView.get(this.o.db, path);
    const gone = this.folder.remove(path, expectHash);
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
    this.misnamed = this.folder.misnamed();
  }

  /** Forgets a project's files (it was removed), never yours. */
  forgetProject(projectId: string, by: MemoryBy): void {
    // Every one, by its folder (task re-review, 2026-11-22: a search's limit left all past the first 1000).
    const folder = `projects/${projectId}/`;
    for (const path of memoryView.paths(this.o.db)) if (path.startsWith(folder)) this.forget(path, by);
  }

  /** The index's files a query finds (scope, who may see them, type, status, words). */
  find(q: MemoryQuery): MemoryRow[] {
    return memoryView.search(this.o.db, q);
  }

  /** One file in the index, or nothing. */
  row(path: string): MemoryRow | undefined {
    return memoryView.get(this.o.db, path);
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
    return [...this.broken.values(), ...this.misnamed].sort();
  }

  /** Yours and one project's or several (null: all), with each broken file's line. */
  list(projects: string | string[] | null, see: MemorySee[]): MemoryInfo[] {
    const ids = typeof projects === "string" ? [projects] : projects;
    return memoryView.list(this.o.db, ids, see).map((m) => {
      const problem = this.broken.get(m.memoryId);
      return problem ? { ...m, problem } : m;
    });
  }

  /** A short note as its own file (the name is its start, the description its first line). */
  note(scope: MemoryScope, text: string, by: MemoryBy, o: NoteOptions = {}): string {
    const t = text.trim();
    if (!t) throw new UserError("A memory can't be empty");
    const lines = cleanLines(t);
    const name = lines.join(" ").replace(/\s+/g, " ").trim().slice(0, 60).trimEnd();
    const description = lines[0]!.trim().slice(0, 160).trimEnd();
    const header = {
      name,
      description,
      type: "fact" as const,
      ...(o.from ? { from: o.from } : {}),
      ...(o.see ? { see: o.see } : {}),
    };
    return this.write({ scope, header, text: t, by, ...(o.overCap ? { overCap: true } : {}) }).path;
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
  const root = join(dataDir, "memory");
  ownedFolder(root);
  ownedFolder(join(root, "projects"));
  const memory = new MemoryFiles({ root, store, db });
  moveNotes(memory, store);
  memory.reindex();
  return memory;
}

/** A folder only you can open (made so, or set so: mkdir's mode doesn't touch one that's there). */
function ownedFolder(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isDirectory()) chmodSync(dir, 0o700);
  } catch (e) {
    console.warn(`Memory: ${dir} isn't a folder ion can use (${(e as Error).message})`);
  }
}
