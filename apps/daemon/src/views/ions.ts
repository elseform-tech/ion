import { DEFAULT_PROJECT } from "@ion/config";
import { type IonCard, EV, type IonEvent, type IonInfo, type ProjectInfo, ION_COLORS } from "@ion/schema";
import type { Db, View } from "../store/index.js";
import { chatsView, previewOf } from "./chats.js";
import { needsView } from "./needs.js";

/** Ion colours, from the lab's palette, in the order projects take them. Identity only, never status. */
const PALETTE = ION_COLORS.map((c) => c.hex);

const ionOf = (chatId: string) => (chatId.startsWith("ion:") ? chatId.slice(4) : null);

/** An ion's words, or, when it said none, its card's gist (ion chief's routing says it with the card). */
function lineOf(d: { text: string; card?: IonCard }): string {
  if (d.text || d.card?.kind !== "threads") return previewOf(d.text);
  const n = new Set(d.card.threads.map((t) => t.projectId)).size;
  return `Asked ${n} project${n === 1 ? "" : "s"}.`;
}

type SessionData = { ionId: string; harness: string | null; nativeId: string | null; projects?: string[] };

/** An ion's session and the projects it could see, or (both null) none: a turn on it failed. */
function noteSession(db: Db, d: SessionData): void {
  if (d.harness === null || d.nativeId === null) {
    db.prepare("DELETE FROM view_ion_sessions WHERE ion_id = ?").run(d.ionId);
    return;
  }
  db.prepare(
    "INSERT INTO view_ion_sessions (ion_id, harness, native_id, projects) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(ion_id) DO UPDATE SET harness = excluded.harness, native_id = excluded.native_id, " +
      "projects = excluded.projects",
  ).run(d.ionId, d.harness, d.nativeId, d.projects ? JSON.stringify(d.projects) : null);
}

type IonSession = { harness: string; nativeId: string; projects: string[] | null };

type IonsView = View & {
  list(db: Db, projects: ProjectInfo[]): IonInfo[];
  /** The agent session the ion last thought in (and the projects it saw), to resume; null before its first. */
  session(db: Db, ionId: string): IonSession | null;
};

/**
 * Each ion's last line and its agent session; the rest of an ion (its needs, whether it's working) is read from
 * the chats and needs.
 */
export const ionsView: IonsView = {
  name: "ions",
  version: 4,
  tables: ["view_ions", "view_ion_sessions"],
  migrate(db) {
    db.exec("CREATE TABLE IF NOT EXISTS view_ions (ion_id TEXT PRIMARY KEY, last TEXT)");
    db.exec(
      "CREATE TABLE IF NOT EXISTS view_ion_sessions (ion_id TEXT PRIMARY KEY, harness TEXT NOT NULL, native_id TEXT NOT NULL, projects TEXT)",
    );
  },
  reset(db) {
    db.exec("DELETE FROM view_ions");
    db.exec("DELETE FROM view_ion_sessions");
  },
  apply(db, e: IonEvent) {
    if (e.type === EV.ionSession) return noteSession(db, e.data as SessionData);
    const ionId = e.chatId ? ionOf(e.chatId) : null;
    if (!ionId || e.type !== EV.ionSaid) return;
    // ion chief's suggestions are optional: its last line stays what it last told you.
    const kind = (e.data as { card?: IonCard }).card?.kind;
    if (kind === "routine" || kind === "stalled") return;
    db.prepare(
      "INSERT INTO view_ions (ion_id, last) VALUES (?, ?) ON CONFLICT(ion_id) DO UPDATE SET last = excluded.last",
    ).run(ionId, lineOf(e.data as { text: string; card?: IonCard }));
  },
  session(db, ionId) {
    const r = db
      .prepare("SELECT harness, native_id AS nativeId, projects FROM view_ion_sessions WHERE ion_id = ?")
      .get(ionId) as { harness: string; nativeId: string; projects: string | null } | undefined;
    if (!r) return null;
    const projects = r.projects ? (JSON.parse(r.projects) as string[]) : null;
    return { harness: r.harness, nativeId: r.nativeId, projects };
  },
  /** ion chief first, then one ion per project; `default` has none (it pools chats without a project). */
  list(db, projects) {
    const last = new Map(
      (
        db.prepare("SELECT ion_id AS ionId, last FROM view_ions").all() as { ionId: string; last: string }[]
      ).map((r) => [r.ionId, r.last]),
    );
    const threads = chatsView.list(db).filter((c) => c.by === "ion" && !c.archived);
    const project = new Map(threads.map((c) => [c.chatId, c.projectId ?? ""]));
    const asks = needsView.open(db).filter((n) => project.has(n.chatId));
    const busy = new Set(
      threads.filter((c) => ["queued", "running"].includes(c.lastRunStatus ?? "")).map((c) => c.projectId),
    );
    const own = projects.filter((p) => p.id !== DEFAULT_PROJECT);
    return [
      {
        ionId: "chief",
        name: "ion",
        color: null,
        harness: null,
        last: last.get("chief") ?? null,
        starred: false,
        needs: asks.length,
        working: busy.size > 0,
      },
      ...own.map((p, i) => ({
        ionId: p.id,
        name: p.name ?? p.id,
        color: p.color ?? PALETTE[i % PALETTE.length]!,
        // The lab draws an ion on its agent's shape: the project's own agent, else the one its latest chat ran on.
        harness: p.harness ?? chatsView.lastAgent(db, p.id),
        last: last.get(p.id) ?? null,
        needs: asks.filter((n) => project.get(n.chatId) === p.id).length,
        working: busy.has(p.id),
        starred: p.starred,
      })),
    ];
  },
};
