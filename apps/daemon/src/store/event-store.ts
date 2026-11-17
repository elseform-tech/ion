import { type IonEvent, type NewEvent, parseEvent, SCHEMA_VERSION } from "@ion/schema";
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

/** The only writer of events. Append-only; views update in the same transaction. */
export class EventStore {
  private listeners = new Set<(e: IonEvent) => void>();

  constructor(
    private readonly db: Db,
    private readonly views: View[] = [],
  ) {
    for (const v of views) v.migrate(db);
  }

  append(input: NewEvent & { id?: string; ts?: string }): IonEvent {
    const id = input.id ?? ulid();
    const stream = input.runId ? `run:${input.runId}` : input.chatId ? `chat:${input.chatId}` : "global";
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

  read(q: { chatId?: string; runId?: string; afterId?: string; limit?: number } = {}): IonEvent[] {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      where.push(clause);
      params.push(value);
    };
    if (q.chatId !== undefined) add("chat_id = ?", q.chatId);
    if (q.runId !== undefined) add("run_id = ?", q.runId);
    if (q.afterId !== undefined) {
      const at = this.db.prepare("SELECT rowid AS r FROM events WHERE id = ?").get(q.afterId) as
        | { r: number }
        | undefined;
      if (!at) throw new Error(`Unknown event id: ${q.afterId}`);
      add("rowid > ?", at.r);
    }
    const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid LIMIT ?`;
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

export function rebuildViews(db: Db, views: View[]): void {
  db.transaction(() => {
    for (const v of views) v.reset(db);
    const rows = db.prepare("SELECT * FROM events ORDER BY rowid").all() as Row[];
    for (const r of rows) {
      const e = toEvent(r);
      for (const v of views) v.apply(db, e);
    }
  }).immediate();
}
