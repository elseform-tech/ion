import { randomBytes } from "node:crypto";
import { loadUserConfig } from "@ion/config";
import { EV, type IonEvent, type MemoryScope } from "@ion/schema";
import type { MemoryFiles } from "../memory/index.js";
import { closeTodo, sharedIds } from "../memory/todos.js";
import type { Db, EventStore } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import type { MemoryRow } from "../views/memory.js";
import { type ChiefCard, cardThread, sameAs, suggestionsView } from "../views/suggestions.js";
import { askOf } from "./suggestions.js";

export type TodoOffersDeps = {
  store: EventStore;
  db: Db;
  memory: MemoryFiles;
  configFile: string;
  /** The files a chat changed in its worktree (none: no worktree). */
  changed: (chatId: string) => Promise<string[]>;
};

type TodoCard = Extract<ChiefCard, { kind: "todo" }>;

/** Words that say nothing about what a to-do is. */
const STOP = new Set(
  "the and for with that this from into our your all now then some later need needs todo please also when what".split(
    " ",
  ),
);
/** "updated", "updates", "updating" and "update" alike. */
const stem = (w: string) => (w.length > 4 ? w.replace(/(?:ing|ed|es|s|e)$/, "") : w);

/** A text's telling words (3 letters or more), each by its stem. */
function wordsOf(text: string): Set<string> {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  return new Set(words.filter((w) => w.length >= 3 && !STOP.has(w)).map(stem));
}

/** At least half of the to-do's telling words are in what the chat did. */
function matches(t: MemoryRow, did: Set<string>): boolean {
  const want = wordsOf(`${t.name} ${t.description}`);
  const hits = [...want].filter((w) => did.has(w)).length;
  return hits > 0 && hits * 2 >= want.size;
}

const isOpen = (r: MemoryRow | undefined) => r?.type === "todo" && r.status === "open";

/**
 * When a chat finishes work that matches an open to-do (yours, or its project's), its ion offers "Mark done?" with
 * Done / Not yet: yours in ion chief's thread (only for a project shared with it), a project's in its ion's. Cheap:
 * by words, from the index, the chat's title, its last reply and the files it changed. Once per to-do and chat; it
 * never closes one on its own.
 */
export class TodoOffers {
  private pending = 0;

  constructor(private readonly d: TodoOffersDeps) {}

  /** Listens for chats' runs that finish. Returns stop. */
  watch(): () => void {
    return this.d.store.onAppend((e) => this.heard(e));
  }

  /** No look is under way (for tests). */
  idle(): boolean {
    return this.pending === 0;
  }

  /** The to-do is still open. */
  open(path: string): boolean {
    return isOpen(this.d.memory.row(path));
  }

  /** Done: marks it done, as you. */
  done(path: string): void {
    closeTodo(this.d.memory, path);
  }

  private heard(e: IonEvent): void {
    if (e.type !== EV.runFinished || (e.data as { status: string }).status !== "done") return;
    if (!e.chatId || e.chatId.startsWith("ion:")) return;
    const chatId = e.chatId;
    this.pending++;
    void this.look(chatId, e.runId)
      .catch((err: unknown) => console.warn(`ion couldn't look at to-dos: ${(err as Error).message}`))
      .finally(() => this.pending--);
  }

  private async look(chatId: string, runId: string | null): Promise<void> {
    const chat = chatsView.list(this.d.db).find((c) => c.chatId === chatId);
    if (!chat?.projectId) return;
    const projectId = chat.projectId;
    const todos = this.todosFor(projectId);
    if (!todos.length) return;
    const reply = runId
      ? (this.d.store.read({ runId, types: [EV.messageCompleted] }).at(-1)?.data as
          | { text?: string }
          | undefined)
      : undefined;
    const files = await this.d.changed(chatId).catch(() => []);
    const did = wordsOf([chat.title, reply?.text ?? "", ...files].join(" "));
    for (const t of todos.filter((x) => matches(x, did))) {
      const card: TodoCard = {
        kind: "todo",
        suggestionId: newId(),
        chatId,
        projectId,
        path: t.path,
        name: t.name,
      };
      if (suggestionsView.offered(this.d.db, sameAs(card)) || !this.open(t.path)) continue;
      const thread = cardThread(card);
      this.d.store.append({
        chatId: thread,
        runId: null,
        origin: "daemon",
        type: EV.ionSaid,
        data: { text: askOf(card), card },
      });
    }
  }

  /** Open to-dos a chat in this project may close: its project's, and yours while the project is shared with ion chief. */
  private todosFor(projectId: string): MemoryRow[] {
    const shared = sharedIds(loadUserConfig(this.d.configFile).config).includes(projectId);
    const scopes: MemoryScope[] = [{ projectId }, ...(shared ? ["you" as const] : [])];
    const q = { scopes, see: ["chats", "ions"] as const, type: "todo" as const, status: "open" as const };
    return this.d.memory.find({ ...q, see: [...q.see], limit: Number.MAX_SAFE_INTEGER });
  }
}

const newId = () => `s${randomBytes(4).toString("hex")}`;
