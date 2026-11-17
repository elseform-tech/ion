import { EV, type IonEvent, type MemoryInfo } from "@ion/schema";
import type { Db, View } from "../store/index.js";

type Written = {
  memoryId: string;
  scope: "you" | { projectId: string };
  text: string;
  source: "you" | { chatId: string; runId: string };
};

/** What ion remembers: yours ("you") and each project's, minus what you've forgotten. */
export const memoryView: View & {
  list(db: Db, projectId: string | null): MemoryInfo[];
  has(db: Db, memoryId: string): boolean;
} = {
  name: "memory",
  version: 1,
  tables: ["view_memory"],
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS view_memory (
      memory_id TEXT PRIMARY KEY, scope TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL, written_at TEXT NOT NULL)`);
  },
  reset(db) {
    db.exec("DELETE FROM view_memory");
  },
  apply(db, e: IonEvent) {
    if (e.type === EV.memoryWritten) {
      const d = e.data as Written;
      const scope = d.scope === "you" ? "you" : d.scope.projectId;
      const source = d.source === "you" ? "you" : d.source.chatId;
      db.prepare(
        "INSERT OR REPLACE INTO view_memory (memory_id, scope, text, source, written_at) VALUES (?, ?, ?, ?, ?)",
      ).run(d.memoryId, scope, d.text, source, e.ts);
    } else if (e.type === EV.memoryForgotten) {
      db.prepare("DELETE FROM view_memory WHERE memory_id = ?").run(
        String((e.data as { memoryId: string }).memoryId),
      );
    }
  },
  list(db, projectId) {
    const where = projectId === null ? "" : "WHERE scope = ? OR scope = 'you'";
    return db
      .prepare(
        `SELECT memory_id AS memoryId, scope, text, source, written_at AS writtenAt FROM view_memory ${where}
         ORDER BY rowid`,
      )
      .all(...(projectId === null ? [] : [projectId])) as MemoryInfo[];
  },
  has(db, memoryId) {
    return db.prepare("SELECT 1 FROM view_memory WHERE memory_id = ?").get(memoryId) !== undefined;
  },
};
