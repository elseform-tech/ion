import type { Db } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { runsView } from "../views/runs.js";
import { listArtifacts, listTasks, readWorktreeFile, stopTask } from "../workspace/index.js";
import type { Handlers } from "./commands.js";
import { UserError } from "./errors.js";

/** A chat's worktree, while it has one (an archived chat's is gone). */
function worktreeOf(db: Db, chatId: unknown): string {
  const dir = chatsView.worktree(db, String(chatId ?? ""));
  if (!dir) throw new UserError("That chat has no workspace");
  return dir;
}

/** The side panel's Preview and Tasks: a chat's files, and what's still running in its worktree. */
export const workspaceHandlers: Pick<Handlers, "chat.tasks" | "chat.artifacts" | "task.stop" | "chat.file"> =
  {
    "chat.tasks": (a, ctx) => listTasks(worktreeOf(ctx.db, a.chatId), String(a.chatId)),
    "chat.artifacts": (a, ctx) => {
      const chatId = String(a.chatId ?? "");
      const dir = chatsView.worktree(ctx.db, chatId);
      // Everything since the chat's first run; no run yet, nothing made.
      const first = runsView.since(ctx.db, [chatId], "").at(-1);
      return dir && first ? listArtifacts(dir, first.startedAt) : [];
    },
    "task.stop": async (a, ctx) => {
      await stopTask(worktreeOf(ctx.db, a.chatId), String(a.chatId), Number(a.pid));
      return { ok: true as const };
    },
    "chat.file": (a, ctx) => readWorktreeFile(worktreeOf(ctx.db, a.chatId), String(a.path ?? "")),
  };
