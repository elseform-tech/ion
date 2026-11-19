import { type AskBrain, EV, type IonEvent, type QueuedInfo, type QueueTarget } from "@ion/schema";
import type { Db, View } from "../store/index.js";

/** A queued message's state: waiting to go out, sent, or removed (by you, or with its chat). */
type State = "waiting" | "sent" | "removed";

/** A queued message as kept: where it goes, and whether it's still waiting. */
export type QueuedRow = QueuedInfo & { to: QueueTarget; state: State };

type Row = {
  queueId: string;
  kind: "chat" | "ion";
  target: string;
  text: string;
  brain: string;
  state: State;
  addedAt: string;
  why: string | null;
};

const SELECT = `SELECT queue_id AS queueId, kind, target, text, brain, state, added_at AS addedAt, why FROM view_queue`;

const targetOf = (to: QueueTarget): ["chat" | "ion", string] =>
  "chatId" in to ? ["chat", to.chatId] : ["ion", to.ionId];

function toRow(r: Row): QueuedRow {
  return {
    queueId: r.queueId,
    text: r.text,
    brain: JSON.parse(r.brain) as AskBrain,
    addedAt: r.addedAt,
    to: r.kind === "chat" ? { chatId: r.target } : { ionId: r.target },
    state: r.state,
    ...(r.why ? { why: r.why } : {}),
  };
}

/** Each chat's and each ion's queued messages (Plan 16), oldest first. */
export const queueView: View & {
  /** What waits to go to a chat or an ion, oldest first. */
  waiting(db: Db, to: QueueTarget): QueuedRow[];
  /** Every chat and ion with a message waiting. */
  targets(db: Db): QueueTarget[];
  find(db: Db, queueId: string): QueuedRow | null;
} = {
  name: "queue",
  version: 1,
  tables: ["view_queue"],
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS view_queue (
      queue_id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL, text TEXT NOT NULL,
      brain TEXT NOT NULL, state TEXT NOT NULL, added_at TEXT NOT NULL, why TEXT)`);
  },
  reset(db) {
    db.exec("DELETE FROM view_queue");
  },
  apply(db, e: IonEvent) {
    const d = e.data as { queueId: string; to: QueueTarget; text: string; brain: AskBrain; why?: string };
    if (e.type === EV.queueAdded) {
      const [kind, target] = targetOf(d.to);
      db.prepare(
        "INSERT OR IGNORE INTO view_queue (queue_id, kind, target, text, brain, state, added_at) VALUES (?, ?, ?, ?, ?, 'waiting', ?)",
      ).run(d.queueId, kind, target, d.text, JSON.stringify(d.brain), e.ts);
    } else if (e.type === EV.queueFailed) {
      db.prepare("UPDATE view_queue SET why = ? WHERE queue_id = ?").run(String(d.why), d.queueId);
    } else if (e.type === EV.queueSent || e.type === EV.queueRemoved) {
      const state = e.type === EV.queueSent ? "sent" : "removed";
      db.prepare("UPDATE view_queue SET state = ? WHERE queue_id = ? AND state = 'waiting'").run(
        state,
        d.queueId,
      );
    }
  },
  waiting(db, to) {
    const [kind, target] = targetOf(to);
    const sql = `${SELECT} WHERE kind = ? AND target = ? AND state = 'waiting' ORDER BY rowid`;
    return (db.prepare(sql).all(kind, target) as Row[]).map(toRow);
  },
  targets(db) {
    const sql = "SELECT DISTINCT kind, target FROM view_queue WHERE state = 'waiting' ORDER BY kind, target";
    return (db.prepare(sql).all() as { kind: string; target: string }[]).map((r) =>
      r.kind === "chat" ? { chatId: r.target } : { ionId: r.target },
    );
  },
  find(db, queueId) {
    const r = db.prepare(`${SELECT} WHERE queue_id = ?`).get(queueId) as Row | undefined;
    return r ? toRow(r) : null;
  },
};
