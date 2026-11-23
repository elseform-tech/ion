import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type MemoryFiles, openMemory } from "../memory/index.js";
import { type Db, EventStore, openDb } from "../store/index.js";
import type { AdapterEvent } from "@ion/adapter-kit";
import { allViews } from "../views/index.js";
import { recordTo } from "../views/usage.js";

/**
 * The data folder (only you can read it), the event store in it, your memory folder (indexed), and `record`: keeps what
 * the judge and ion's quick model spend, and a limit they hit, in each agent's usage (views/usage.ts).
 */
export function openStore(dataDir: string): {
  db: Db;
  store: EventStore;
  memory: MemoryFiles;
  record: (harness: string, e: AdapterEvent, startedAt: string) => void;
} {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700); // mkdir's mode doesn't touch a folder that already exists
  const db = openDb(join(dataDir, "ion.db"));
  const store = new EventStore(db, allViews);
  return { db, store, memory: openMemory(dataDir, store, db), record: recordTo(store) };
}
