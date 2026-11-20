import { type EventType, type IonEvent, type NewEvent, parseEvent, SCHEMA_VERSION } from "@ion/schema";
import { monotonicFactory } from "ulid";

const ulid = monotonicFactory();
import type { Db } from "./db.js";
import type { View } from "./view.js";

type Row = {
  id: string;
  chat_id: string | null;
  run_id: string | null;
  seq: number;
  ts: string;
  origin: string;
  type: string;
  data: string;
  native: string | null;
};

const toEvent = (r: Row): IonEvent =>
  ({
    v: SCHEMA_VERSION,
    id: r.id,
    chatId: r.chat_id,
    runId: r.run_id,
    seq: r.seq,
    ts: r.ts,
    origin: r.origin,
    type: r.type,
    data: JSON.parse(r.data),
    ...(r.native ? { native: JSON.parse(r.native) } : {}),
  }) as IonEvent;

/** Each run numbers its own events; chat-level events number per chat; the rest share "global". */
function streamKey(runId: string | null, chatId: string | null): string {
  if (runId) return `run:${runId}`;
  if (chatId) return `chat:${chatId}`;
  return "global";
}

/** The only writer of events. Append-only; views update in the same transaction. */
export class EventStore {
  private listeners = new Set<(e: IonEvent) => void>();

  constructor(
    private readonly db: Db,
    private readonly views: View[] = [],
  ) {
    // One transaction: if the rebuild fails or ion is killed mid-way, the versions aren't advanced either, so the
    // next start upgrades again instead of leaving a view empty.
    db.transaction(() => {
      if (upgradeViews(db, views)) replayInto(db, views);
    }).immediate();
  }

  append(input: NewEvent & { id?: string; ts?: string }): IonEvent {
    const id = input.id ?? ulid();
    const stream = streamKey(input.runId, input.chatId);
    const tx = this.db.transaction((): { event: IonEvent; fresh: boolean } => {
      const existing = this.db.prepare("SELECT * FROM events WHERE id = ?").get(id) as Row | undefined;
      if (existing) {
        const same =
          existing.chat_id === input.chatId &&
          existing.run_id === input.runId &&
          existing.origin === input.origin &&
          existing.type === input.type &&
          existing.data === JSON.stringify(input.data);
        if (!same) throw new Error(`Event id ${id} is already used by a different event`);
        return { event: toEvent(existing), fresh: false };
      }
      const last = this.db.prepare("SELECT max(seq) AS s FROM events WHERE stream = ?").get(stream) as {
        s: number | null;
      };
      const event = parseEvent({
        v: SCHEMA_VERSION,
        id,
        chatId: input.chatId,
        runId: input.runId,
        seq: (last.s ?? 0) + 1,
        ts: input.ts ?? new Date().toISOString(),
        origin: input.origin,
        type: input.type,
        data: input.data,
        ...(input.native ? { native: input.native } : {}),
      });
      this.db
        .prepare(
          "INSERT INTO events (id, stream, chat_id, run_id, seq, ts, origin, type, data, native) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          event.id,
          stream,
          event.chatId,
          event.runId,
          event.seq,
          event.ts,
          event.origin,
          event.type,
          JSON.stringify(event.data),
          event.native ? JSON.stringify(event.native) : null,
        );
      for (const v of this.views) v.apply(this.db, event);
      return { event, fresh: true };
    });
    const { event, fresh } = tx.immediate();
    if (fresh) for (const fn of this.listeners) fn(event);
    return event;
  }

  /** Events in order; `since`: at or after this time (ISO), `types`: only these. */
  read(
    q: {
      chatId?: string;
      runId?: string;
      afterId?: string;
      limit?: number;
      since?: string;
      types?: readonly EventType[];
    } = {},
  ): IonEvent[] {
    if (q.types?.length === 0) return [];
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      where.push(clause);
      params.push(value);
    };
    if (q.chatId !== undefined) add("chat_id = ?", q.chatId);
    if (q.runId !== undefined) add("run_id = ?", q.runId);
    if (q.since !== undefined) add("ts >= ?", q.since);
    if (q.types) {
      where.push(`type IN (${q.types.map(() => "?").join(", ")})`);
      params.push(...q.types);
    }
    if (q.afterId !== undefined) {
      const at = this.db.prepare("SELECT rowid AS r FROM events WHERE id = ?").get(q.afterId) as
        | { r: number }
        | undefined;
      if (!at) throw new Error(`Unknown event id: ${q.afterId}`);
      add("rowid > ?", at.r);
    }
    const filter = where.length ? "WHERE " + where.join(" AND ") : "";
    const sql = `SELECT * FROM events ${filter} ORDER BY rowid LIMIT ?`;
    params.push(q.limit ?? 10_000);
    return (this.db.prepare(sql).all(...params) as Row[]).map(toEvent);
  }

  onAppend(fn: (e: IonEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Clears every view and replays the whole log into it. */
  rebuildViews(): void {
    rebuildViews(this.db, this.views);
  }
}

function rebuildViews(db: Db, views: View[]): void {
  db.transaction(() => replayInto(db, views)).immediate();
}

/** Clears every view and replays the whole log into it (inside the caller's transaction). */
function replayInto(db: Db, views: View[]): void {
  for (const v of views) v.reset(db);
  const rows = db.prepare("SELECT * FROM events ORDER BY rowid").all() as Row[];
  for (const r of rows) {
    const e = toEvent(r);
    for (const v of views) v.apply(db, e);
  }
}

/** Creates every view's tables; a view whose version changed is dropped first. True if any needs a rebuild. */
function upgradeViews(db: Db, views: View[]): boolean {
  db.exec("CREATE TABLE IF NOT EXISTS view_versions (name TEXT PRIMARY KEY, version INTEGER NOT NULL)");
  let stale = false;
  for (const v of views) {
    const version = v.version ?? 1;
    const row = db.prepare("SELECT version FROM view_versions WHERE name = ?").get(v.name) as
      | { version: number }
      | undefined;
    if (row?.version !== version) {
      for (const t of v.tables ?? []) db.exec(`DROP TABLE IF EXISTS "${t.replaceAll('"', "")}"`);
      db.prepare("INSERT OR REPLACE INTO view_versions (name, version) VALUES (?, ?)").run(v.name, version);
      stale = stale || row !== undefined || (v.tables ?? []).length > 0;
    }
    v.migrate(db);
  }
  return stale;
}
