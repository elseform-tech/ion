import type { Db } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { listTasks, readWorktreeFile, stopTask } from "../workspace/index.js";
import type { Handlers } from "./commands.js";
import { UserError } from "./errors.js";

/** A chat's worktree, while it has one (an archived chat's is gone). */
function worktreeOf(db: Db, chatId: unknown): string {
  const dir = chatsView.worktree(db, String(chatId ?? ""));
  if (!dir) throw new UserError("That chat has no workspace");
  return dir;
}

/** The side panel's Preview and Tasks: a chat's files, and what's still running in its worktree. */
export const workspaceHandlers: Pick<Handlers, "chat.tasks" | "task.stop" | "chat.file"> = {
  "chat.tasks": (a, ctx) => listTasks(worktreeOf(ctx.db, a.chatId), String(a.chatId)),
  "task.stop": async (a, ctx) => {
    await stopTask(worktreeOf(ctx.db, a.chatId), String(a.chatId), Number(a.pid));
    return { ok: true as const };
  },
  "chat.file": (a, ctx) => readWorktreeFile(worktreeOf(ctx.db, a.chatId), String(a.path ?? "")),
};
