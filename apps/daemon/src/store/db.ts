import Database from "better-sqlite3";

export type Db = Database.Database;

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS events (
     id TEXT PRIMARY KEY,
     stream TEXT NOT NULL,
     chat_id TEXT,
     run_id TEXT,
     seq INTEGER NOT NULL,
     ts TEXT NOT NULL,
     origin TEXT NOT NULL,
     type TEXT NOT NULL,
     data TEXT NOT NULL,
     native TEXT,
     UNIQUE (stream, seq)
   )`,
  `CREATE INDEX IF NOT EXISTS events_chat ON events (chat_id, id)`,
];

/** Opens (or creates) the database in WAL mode and applies migrations. ":memory:" is allowed. */
export function openDb(file: string): Db {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const sql of MIGRATIONS) db.exec(sql);
  return db;
}
