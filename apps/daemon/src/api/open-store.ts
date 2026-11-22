import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type MemoryFiles, openMemory } from "../memory/index.js";
import { type Db, EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";

/** The data folder (only you can read it), the event store in it, and your memory folder (indexed). */
export function openStore(dataDir: string): { db: Db; store: EventStore; memory: MemoryFiles } {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700); // mkdir's mode doesn't touch a folder that already exists
  const db = openDb(join(dataDir, "ion.db"));
  const store = new EventStore(db, allViews);
  return { db, store, memory: openMemory(dataDir, store, db) };
}
