import { EV, type IonCard, type IonEvent } from "@ion/schema";
import type { Asked } from "../ions/habits.js";
import type { Db, View } from "../store/index.js";

type D = Record<string, unknown>;

/**
 * What you asked for in each project, for ion chief's routine suggestions: your messages to its ion, and the chats
 * you started there (their title and first message). ion's own threads aren't yours.
 */
export const asksView: View & { list(db: Db, projectId: string): Asked[] } = {
  name: "asks",
  version: 1,
  tables: ["view_asks"],
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS view_asks (
      project_id TEXT NOT NULL, at TEXT NOT NULL, text TEXT, title TEXT, chat_id TEXT)`);
  },
  reset(db) {
    db.exec("DELETE FROM view_asks");
  },
  apply(db, e: IonEvent) {
    if (!e.chatId) return;
    const d = e.data as D;
    const add = (projectId: string, text: string | null, title: string | null, chatId: string | null) =>
      db
        .prepare("INSERT INTO view_asks (project_id, at, text, title, chat_id) VALUES (?, ?, ?, ?, ?)")
        .run(projectId, e.ts, text, title, chatId);
    if (e.type === EV.ionHeard && e.chatId.startsWith("ion:") && e.chatId !== "ion:chief")
      add(e.chatId.slice(4), String(d.text), null, null);
    else if (e.type === EV.chatCreated && d.by !== "ion" && typeof d.projectId === "string")
      add(d.projectId, null, String(d.title), e.chatId);
    else if (e.type === EV.messageSent)
      db.prepare("UPDATE view_asks SET text = ? WHERE chat_id = ? AND text IS NULL").run(
        String(d.text),
        e.chatId,
      );
  },
  list(db, projectId) {
    const rows = db
      .prepare("SELECT at, text, title, chat_id AS chatId FROM view_asks WHERE project_id = ? ORDER BY rowid")
      .all(projectId) as { at: string; text: string | null; title: string | null; chatId: string | null }[];
    return rows.map((r) => ({ ...r, at: new Date(r.at) }));
  },
};

/** The ions' own suggestions: ion chief's routine or stalled chat, and an ion's "Mark done?" for a to-do. */
export type ChiefCard = Extract<IonCard, { kind: "routine" | "stalled" | "todo" }>;
type Answer = "took" | "dismissed" | "muted";
export type SuggestionRow = { card: ChiefCard; at: string; answer: Answer | null };

/** What makes two suggestions the same: a routine for the same words in a project; a chat, stalled since the same time. */
export const sameAs = (c: ChiefCard): string => {
  if (c.kind === "routine") return `routine:${c.projectId}:${c.key}`;
  // A to-do is offered once per chat: Not yet means not for this chat.
  return c.kind === "todo" ? `todo:${c.path}:${c.chatId}` : `stalled:${c.chatId}:${c.since}`;
};

/** The ion thread a card is in: a project's to-do in its ion's, the rest in ion chief's. */
export const cardThread = (c: ChiefCard): string =>
  c.kind === "todo" && c.path.startsWith("projects/") ? `ion:${c.projectId}` : "ion:chief";

const isChief = (card: IonCard | undefined): card is ChiefCard =>
  card?.kind === "routine" || card?.kind === "stalled" || card?.kind === "todo";

const answerOf = (d: D): Answer => {
  if (d.keep === true) return "took";
  return d.mute === true ? "muted" : "dismissed";
};

/** The ions' suggestions and your answers: so the same one never comes twice, across restarts. */
export const suggestionsView: View & {
  find(db: Db, suggestionId: string): SuggestionRow | null;
  offered(db: Db, same: string): boolean;
  muted(db: Db, projectId: string, kind: ChiefCard["kind"]): boolean;
  list(db: Db): SuggestionRow[];
} = {
  name: "suggestions",
  version: 2,
  tables: ["view_suggestions"],
  migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS view_suggestions (
      suggestion_id TEXT PRIMARY KEY, kind TEXT NOT NULL, project_id TEXT NOT NULL, same TEXT NOT NULL,
      card TEXT NOT NULL, at TEXT NOT NULL, answer TEXT)`);
  },
  reset(db) {
    db.exec("DELETE FROM view_suggestions");
  },
  apply(db, e: IonEvent) {
    if (!e.chatId?.startsWith("ion:")) return;
    const d = e.data as D;
    const card = d.card as IonCard | undefined;
    // ion chief's own cards only in its thread; a project's "Mark done?" in its ion's.
    if (e.type === EV.ionSaid && isChief(card) && cardThread(card) === e.chatId)
      db.prepare(
        "INSERT OR IGNORE INTO view_suggestions (suggestion_id, kind, project_id, same, card, at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(card.suggestionId, card.kind, card.projectId, sameAs(card), JSON.stringify(card), e.ts);
    if (e.type === EV.suggestionAnswered)
      db.prepare("UPDATE view_suggestions SET answer = ? WHERE suggestion_id = ?").run(
        answerOf(d),
        String(d.suggestionId),
      );
  },
  find(db, suggestionId) {
    const r = db
      .prepare("SELECT card, at, answer FROM view_suggestions WHERE suggestion_id = ?")
      .get(suggestionId) as { card: string; at: string; answer: Answer | null } | undefined;
    return r ? { card: JSON.parse(r.card) as ChiefCard, at: r.at, answer: r.answer } : null;
  },
  offered(db, same) {
    return db.prepare("SELECT 1 FROM view_suggestions WHERE same = ?").get(same) !== undefined;
  },
  muted(db, projectId, kind) {
    return (
      db
        .prepare("SELECT 1 FROM view_suggestions WHERE project_id = ? AND kind = ? AND answer = 'muted'")
        .get(projectId, kind) !== undefined
    );
  },
  list(db) {
    const rows = db.prepare("SELECT card, at, answer FROM view_suggestions ORDER BY rowid").all() as {
      card: string;
      at: string;
      answer: Answer | null;
    }[];
    return rows.map((r) => ({ card: JSON.parse(r.card) as ChiefCard, at: r.at, answer: r.answer }));
  },
};
