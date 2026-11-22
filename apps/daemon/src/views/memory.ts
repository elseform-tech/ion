import {
  EV,
  type IonEvent,
  type MemoryBy,
  type MemoryHeader,
  type MemoryInfo,
  type MemoryScope,
  type MemorySee,
  type MemoryType,
} from "@ion/schema";
import type { Db, View } from "../store/index.js";

/** A memory file in the index: what it is, who may see it, and its last change. */
export type MemoryRow = {
  path: string;
  scope: MemoryScope;
  slug: string;
  name: string;
  description: string;
  type: MemoryType;
  see: MemorySee;
  status: "open" | "done" | null;
  due: string | null;
  hash: string;
  updatedAt: string;
  by: MemoryBy;
};

/** One change to a memory file, from ion's events. */
export type MemoryChange = {
  at: string;
  kind: "written" | "forgotten";
  by: MemoryBy;
  hash?: string;
  header?: MemoryHeader;
  before?: { hash: string; text: string };
};

export type MemoryQuery = {
  /** "you" and the projects asked about; "all": every scope (only you see everything). */
  scopes: MemoryScope[] | "all";
  /** Which files they may see. */
  see: MemorySee[];
  /** Words to find in the name, description or text (best match first). */
  q?: string;
  type?: MemoryType;
  status?: "open" | "done";
  limit?: number;
};

type Written = {
  path: string;
  scope: MemoryScope;
  slug: string;
  header: MemoryHeader;
  hash: string;
  by: MemoryBy;
};

const COLUMNS = `m.path, m.scope, m.slug, m.name, m.description, m.type, m.see, m.status, m.due, m.hash,
  m.updated_at AS updatedAt, m.by`;
type Raw = Omit<MemoryRow, "by" | "scope"> & { by: string; scope: string };
const rowOf = (r: Raw): MemoryRow => ({ ...r, scope: scopeOfKey(r.scope), by: JSON.parse(r.by) as MemoryBy });

/**
 * How a scope is kept in the index: "you", or "project:<id>" (task review, 2026-11-22: a project called "you" shared
 * your scope when both were kept as a bare word).
 */
const scopeKey = (s: MemoryScope) => (s === "you" ? "you" : `project:${s.projectId}`);
const scopeOfKey = (k: string): MemoryScope =>
  k === "you" ? "you" : { projectId: k.slice("project:".length) };
const ANY = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** Who changed it, as the old list said: "you", a chat, or "ion:<id>". */
const sourceOf = (by: MemoryBy) => {
  if (by === "you") return "you";
  return "ion" in by ? `ion:${by.ion}` : by.chatId;
};

/** The words of a query, each quoted (a prefix), so it's plain words, never FTS syntax. */
function matchOf(q: string): string | null {
  const words = q.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return words.length ? words.map((w) => `"${w}"*`).join(" ") : null;
}

function textOf(db: Db, path: string): string {
  const r = db.prepare("SELECT text FROM view_memory_fts WHERE path = ?").get(path) as
    | { text: string }
    | undefined;
  return r?.text ?? "";
}

/** Puts a file's searchable words in: its name and description, and its text (kept when not given). */
function putFts(db: Db, path: string, text?: string): void {
  const m = db.prepare("SELECT name, description FROM view_memory WHERE path = ?").get(path) as
    | { name: string; description: string }
    | undefined;
  const keep = text ?? textOf(db, path);
  db.prepare("DELETE FROM view_memory_fts WHERE path = ?").run(path);
  if (m)
    db.prepare("INSERT INTO view_memory_fts (path, name, description, text) VALUES (?, ?, ?, ?)").run(
      path,
      m.name,
      m.description,
      keep,
    );
}

function applyWritten(db: Db, d: Written, ts: string): void {
  const h = d.header;
  db.prepare(
    `INSERT INTO view_memory (path, scope, slug, name, description, type, see, status, due, hash, updated_at, by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (path) DO UPDATE SET name = excluded.name, description = excluded.description, type = excluded.type,
       see = excluded.see, status = excluded.status, due = excluded.due, hash = excluded.hash,
       updated_at = excluded.updated_at, by = excluded.by`,
  ).run(
    ...[d.path, scopeKey(d.scope), d.slug, h.name, h.description, h.type, h.see],
    ...[h.status ?? null, h.due ?? null, d.hash, ts, JSON.stringify(d.by)],
  );
  putFts(db, d.path);
}

function filtersOf(q: MemoryQuery): { where: string; params: unknown[] } {
  const scoped = q.scopes === "all" ? [] : q.scopes;
  const where = [`m.see IN (${ANY(q.see.length)})`];
  if (q.scopes !== "all") where.push(`m.scope IN (${ANY(scoped.length)})`);
  const params: unknown[] = [...q.see, ...scoped.map(scopeKey)];
  if (q.type) {
    where.push("m.type = ?");
    params.push(q.type);
  }
  if (q.status) {
    where.push("m.status = ?");
    params.push(q.status);
  }
  return { where: where.join(" AND "), params };
}

/**
 * The memory index: each file's header (from ion's events) and its words (from the file, for FTS5). The files are
 * the truth; this is rebuilt from the log and the folder. History is the log itself.
 */
export const memoryView: View & {
  search(db: Db, q: MemoryQuery): MemoryRow[];
  get(db: Db, path: string): (MemoryRow & { text: string }) | undefined;
  history(db: Db, path: string): MemoryChange[];
  /** Puts a file's text in the index (read from the file; the events hold only its header). */
  index(db: Db, path: string, text: string): void;
  paths(db: Db): string[];
  /** Every file, yours and these projects' (null: all), that `see` allows, oldest first, in the old list's shape. */
  list(db: Db, projects: string[] | null, see: MemorySee[]): MemoryInfo[];
} = {
  name: "memory",
  version: 3,
  tables: ["view_memory", "view_memory_fts"],
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS view_memory (
      path TEXT PRIMARY KEY, scope TEXT NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
      type TEXT NOT NULL, see TEXT NOT NULL, status TEXT, due TEXT, hash TEXT NOT NULL, updated_at TEXT NOT NULL,
      by TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS view_memory_fts USING fts5 (path UNINDEXED, name, description, text);`);
  },
  reset(db) {
    db.exec("DELETE FROM view_memory; DELETE FROM view_memory_fts;");
  },
  apply(db, e: IonEvent) {
    // A note from before memory was files has no path: it's moved to a file once (memory/migrate.ts).
    const data = e.data as { path?: string };
    if (typeof data.path !== "string") return;
    if (e.type === EV.memoryWritten) applyWritten(db, e.data as Written, e.ts);
    else if (e.type === EV.memoryForgotten) {
      db.prepare("DELETE FROM view_memory WHERE path = ?").run(data.path);
      db.prepare("DELETE FROM view_memory_fts WHERE path = ?").run(data.path);
    }
  },
  search(db, q) {
    if (!q.scopes.length || !q.see.length) return [];
    const { where, params } = filtersOf(q);
    const limit = q.limit ?? 1000;
    if (q.q === undefined) {
      const order = "ORDER BY (m.type = 'todo' AND m.status = 'open') DESC, m.updated_at DESC, m.rowid DESC";
      return (
        db
          .prepare(`SELECT ${COLUMNS} FROM view_memory m WHERE ${where} ${order} LIMIT ?`)
          .all(...params, limit) as Raw[]
      ).map(rowOf);
    }
    const match = matchOf(q.q);
    if (!match) return [];
    return (
      db
        .prepare(
          `SELECT ${COLUMNS} FROM view_memory_fts f JOIN view_memory m ON m.path = f.path
           WHERE view_memory_fts MATCH ? AND ${where} ORDER BY bm25(view_memory_fts) LIMIT ?`,
        )
        .all(match, ...params, limit) as Raw[]
    ).map(rowOf);
  },
  get(db, path) {
    const r = db.prepare(`SELECT ${COLUMNS} FROM view_memory m WHERE m.path = ?`).get(path) as
      | Raw
      | undefined;
    return r && { ...rowOf(r), text: textOf(db, path) };
  },
  history(db, path) {
    const rows = db
      .prepare(
        `SELECT ts, type, data FROM events WHERE type IN (?, ?) AND json_extract(data, '$.path') = ? ORDER BY rowid`,
      )
      .all(EV.memoryWritten, EV.memoryForgotten, path) as { ts: string; type: string; data: string }[];
    return rows.map((r) => {
      const d = JSON.parse(r.data) as Partial<Written> & { by: MemoryBy; before?: MemoryChange["before"] };
      return {
        at: r.ts,
        kind: r.type === EV.memoryWritten ? "written" : "forgotten",
        by: d.by,
        ...(d.hash ? { hash: d.hash } : {}),
        ...(d.header ? { header: d.header } : {}),
        ...(d.before ? { before: d.before } : {}),
      };
    });
  },
  index(db, path, text) {
    putFts(db, path, text);
  },
  paths(db) {
    return (db.prepare("SELECT path FROM view_memory").all() as { path: string }[]).map((r) => r.path);
  },
  list(db, projects, see) {
    if (!see.length) return [];
    const keys = ["you", ...(projects ?? []).map((id) => scopeKey({ projectId: id }))];
    const scoped = projects === null ? "" : `m.scope IN (${ANY(keys.length)}) AND`;
    const where = `WHERE ${scoped} m.see IN (${ANY(see.length)})`;
    const rows = db
      .prepare(
        `SELECT m.path, m.scope, m.by, m.updated_at AS writtenAt, coalesce(f.text, '') AS text, m.name,
           m.description, m.type, m.see, m.status, m.due
         FROM view_memory m LEFT JOIN view_memory_fts f ON f.path = m.path ${where} ORDER BY m.rowid`,
      )
      .all(...(projects === null ? [] : keys), ...see) as (Pick<
      MemoryRow,
      "name" | "description" | "type" | "see"
    > & {
      path: string;
      scope: string;
      by: string;
      writtenAt: string;
      text: string;
      status: "open" | "done" | null;
      due: string | null;
    })[];
    return rows.map((r) => ({
      memoryId: r.path,
      // "you", or "project:<id>": a legacy folder called you never reads as yours (task re-review, 2026-11-22).
      scope: r.scope,
      ...{ name: r.name, description: r.description, type: r.type, see: r.see },
      ...(r.status ? { status: r.status } : {}),
      ...(r.due ? { due: r.due } : {}),
      text: r.text,
      source: sourceOf(JSON.parse(r.by) as MemoryBy),
      writtenAt: r.writtenAt,
    }));
  },
};
