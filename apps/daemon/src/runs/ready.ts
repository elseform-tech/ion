import type { HarnessEntry } from "../adapters/registry.js";
import { EV } from "@ion/schema";
import { UserError } from "../api/errors.js";
import type { Db, EventStore } from "../store/index.js";
import { chatsView } from "../views/chats.js";

const TITLE_MAX = 60;

/** A chat's title: its first message's first line; a long one is cut at a word and marked "…". */
export function titleOf(text: string): string {
  const line = text.trim().split("\n")[0]!;
  if (line.length <= TITLE_MAX) return line;
  const cut = line.slice(0, TITLE_MAX - 1);
  const word = cut.lastIndexOf(" ");
  return `${(word > TITLE_MAX / 2 ? cut.slice(0, word) : cut).trimEnd()}…`;
}

/** A run's chat: an existing one (refused when unknown or archived), or the one a new ask makes. */
export type Chat = { chatId: string | null; projectId: string | null; title: string };

/** `title`: a new chat's own title (a routine's name), instead of one from the text. */
export function chatFor(
  db: Db,
  args: { chatId?: string; projectId?: string; text: string },
  title?: string,
): Chat {
  if (!args.chatId)
    return { chatId: null, projectId: args.projectId ?? null, title: title ?? titleOf(args.text) };
  const chat = chatsView.list(db).find((c) => c.chatId === args.chatId);
  if (!chat) throw new UserError(`Unknown chat: ${args.chatId}`);
  if (chat.archived) throw new UserError("That chat is archived");
  return { chatId: chat.chatId, projectId: chat.projectId, title: chat.title };
}

/** A new name for a chat, trimmed; at most 120 characters. */
export function renameChat(store: EventStore, db: Db, chatId: string, title: string): void {
  if (!chatsView.list(db).some((c) => c.chatId === chatId)) throw new UserError(`Unknown chat: ${chatId}`);
  const name = title.trim().slice(0, 120);
  if (!name) throw new UserError("Give the chat a name");
  store.append({ chatId, runId: null, origin: "daemon", type: EV.chatRenamed, data: { title: name } });
}

/** How long an agent that was ready counts as ready without asking again. A failed check is asked again. */
const READY_FOR_MS = 2 * 60_000;

/**
 * Whether an agent can take a message: installed, signed in, and (when one is named) the model is one it lists.
 * Asking its CLI costs seconds, so a check that passed holds for a while.
 */
export class Readiness {
  private readonly until = new Map<string, number>();

  async check(h: HarnessEntry, model?: string): Promise<void> {
    const key = `${h.label}\u0000${model ?? ""}`;
    if ((this.until.get(key) ?? 0) > Date.now()) return;
    await ask(h, model);
    this.until.set(key, Date.now() + READY_FOR_MS);
  }
}

async function ask(h: HarnessEntry, model?: string): Promise<void> {
  if (!(await h.adapter.detect()).installed) throw new UserError(`${h.label} isn't installed`);
  if (!(await h.adapter.auth.status()).signedIn)
    throw new UserError(`${h.label} isn't signed in. Run: ${h.loginHint}`);
  // A live model list is the harness's own: a name it doesn't list won't run.
  if (!model) return;
  const caps = await h.adapter.capabilities();
  if (caps.modelsLive && !caps.models.some((x) => x.id === model))
    throw new UserError(`Unknown model for ${h.label}: ${model}`);
}

/** A new chat: its title, project and worktree; `by`: "ion" for a thread ion started (Plan 09). */
export function chatCreated(
  store: EventStore,
  c: { chatId: string; chat: Chat; wt: { path: string; branch: string }; by?: "ion" },
): void {
  store.append({
    chatId: c.chatId,
    runId: null,
    origin: "daemon",
    type: EV.chatCreated,
    data: {
      ...{ title: c.chat.title, projectId: c.chat.projectId, worktree: c.wt.path, branch: c.wt.branch },
      ...(c.by ? { by: c.by } : {}),
    },
  });
}
