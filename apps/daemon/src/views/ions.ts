import { DEFAULT_PROJECT } from "@ion/config";
import { type IonCard, EV, type IonEvent, type IonInfo, type ProjectInfo } from "@ion/schema";
import type { Db, View } from "../store/index.js";
import { chatsView } from "./chats.js";
import { needsView } from "./needs.js";

/** Ion colours, from the lab's palette, in the order projects take them. Identity only, never status. */
const PALETTE = [
  "#ED712E",
  "#5BC67A",
  "#F19D38",
  "#3C82F6",
  "#885CF5",
  "#54B9A6",
  "#EB4699",
  "#EA4045",
  "#97683D",
];

const ionOf = (chatId: string) => (chatId.startsWith("ion:") ? chatId.slice(4) : null);

/** An ion's words, or, when it said none, its card's gist (ion chief's routing says it with the card). */
function lineOf(d: { text: string; card?: IonCard }): string {
  if (d.text || d.card?.kind !== "threads") return d.text;
  const n = new Set(d.card.threads.map((t) => t.projectId)).size;
  return `Asked ${n} project${n === 1 ? "" : "s"}.`;
}

/** Each ion's last line; the rest of an ion (its needs, whether it's working) is read from the chats and needs. */
export const ionsView: View & { list(db: Db, projects: ProjectInfo[]): IonInfo[] } = {
  name: "ions",
  version: 1,
  tables: ["view_ions"],
  migrate(db) {
    db.exec("CREATE TABLE IF NOT EXISTS view_ions (ion_id TEXT PRIMARY KEY, last TEXT)");
  },
  reset(db) {
    db.exec("DELETE FROM view_ions");
  },
  apply(db, e: IonEvent) {
    const ionId = e.chatId ? ionOf(e.chatId) : null;
    if (!ionId || e.type !== EV.ionSaid) return;
    db.prepare(
      "INSERT INTO view_ions (ion_id, last) VALUES (?, ?) ON CONFLICT(ion_id) DO UPDATE SET last = excluded.last",
    ).run(ionId, lineOf(e.data as { text: string; card?: IonCard }));
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
