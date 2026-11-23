import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NeedInfo } from "@ion/schema";
import { z } from "zod";
import { UserError } from "../api/errors.js";
import { wrapData } from "../context/index.js";
import type { MemoryFiles } from "../memory/index.js";
import { chatCaller } from "../memory/switch.js";
import { HISTORY_CHARS } from "../runs/history.js";
import type { Db, EventStore } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { messagesView, type SearchHit } from "../views/messages.js";
import { needsView } from "../views/needs.js";
import type { Decisions } from "../decisions/index.js";
import { askTools } from "./ask.js";
import { registerMemoryTools } from "./memory-tools.js";
import { guard, ok, q } from "./result.js";
import type { Grants, RunScope } from "./grants.js";

export type Deps = { store: EventStore; db: Db; grants: Grants; memory: MemoryFiles; decisions?: Decisions };

export const SEARCH_MAX = 20;
const HIT_CHARS = 500;

/** A chat's last `limit` messages, as data. */
export const historyData = (db: Db, chatId: string, limit: number) => {
  const lines = messagesView.history(db, chatId, HISTORY_CHARS).slice(-limit);
  return ok(wrapData(`chat ${chatId}`, lines.map((m) => `${m.role}: ${q(m.text)}`).join("\n")));
};
export const searchData = (hits: SearchHit[]) =>
  ok(
    wrapData(
      "search results",
      hits.map((h) => `${h.chatId} ${h.role}: ${q(h.text.slice(0, HIT_CHARS))}`).join("\n"),
    ),
  );
export const needsData = (needs: NeedInfo[]) =>
  ok(wrapData("open needs", needs.map((n) => `${n.needId} ${n.chatId}: ${q(n.summary)}`).join("\n")));

/** The tools a run gets, all limited to its own project. Everything they return is labelled as data. */
export function registerTools(server: McpServer, scope: RunScope, d: Deps): void {
  historyTools(server, scope, d);
  memoryTools(server, scope, d);
  if (d.decisions) askTools(server, scope, { db: d.db, decisions: d.decisions });
}

function historyTools(server: McpServer, scope: RunScope, d: Deps): void {
  server.registerTool(
    "chat_history",
    {
      description: "Messages of a chat in this project, oldest first. Defaults to the current chat.",
      inputSchema: { chatId: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
    },
    guard(({ chatId, limit }: { chatId?: string; limit?: number }) => {
      const id = chatId ?? scope.chatId;
      if (chatsView.list(d.db).find((c) => c.chatId === id)?.projectId !== scope.projectId)
        throw new UserError("Not allowed");
      return historyData(d.db, id, limit ?? 200);
    }),
  );
  server.registerTool(
    "search_chats",
    {
      description: "Search this project's chats for words. At most 20 results.",
      inputSchema: { query: z.string().min(1).max(500), limit: z.number().int().min(1).optional() },
    },
    guard(({ query, limit }: { query: string; limit?: number }) => {
      const hits = messagesView.search(
        d.db,
        scope.projectId,
        query,
        Math.min(limit ?? SEARCH_MAX, SEARCH_MAX),
      );
      return searchData(hits);
    }),
  );
  server.registerTool(
    "open_needs",
    { description: "What in this project is waiting on the user.", inputSchema: {} },
    guard(() => {
      return needsData(needsView.open(d.db).filter((n) => n.projectId === scope.projectId));
    }),
  );
}

/** A chat writes at most this many memory files in one run. */
const WRITES_PER_RUN = 20;

/** A run whose memory is off (its project, its chat) gets no memory tools (the user, 2026-11-23). */
function memoryTools(server: McpServer, scope: RunScope, d: Deps): void {
  const caller = chatCaller(scope);
  if (!caller) return;
  // An agent can't flood a project's memory.
  const limit = { id: scope.runId, max: WRITES_PER_RUN, tooMany: "That's enough memory for one run" };
  registerMemoryTools(server, caller, d, limit);
}
