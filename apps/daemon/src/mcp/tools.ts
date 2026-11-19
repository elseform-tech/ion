import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemoryInfo, NeedInfo } from "@ion/schema";
import { z } from "zod";
import { UserError } from "../api/errors.js";
import { wrapData } from "../context/index.js";
import { writeMemory } from "../memory/index.js";
import { HISTORY_CHARS } from "../runs/history.js";
import type { Db, EventStore } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { memoryView } from "../views/memory.js";
import { messagesView, type SearchHit } from "../views/messages.js";
import { needsView } from "../views/needs.js";
import type { Decisions } from "../decisions/index.js";
import { askTools } from "./ask.js";
import { guard, ok, q } from "./result.js";
import type { Grants, RunScope } from "./grants.js";

export type Deps = { store: EventStore; db: Db; grants: Grants; decisions?: Decisions };

const WRITES_PER_RUN = 5;
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
export const memoryData = (list: MemoryInfo[]) =>
  ok(wrapData("memory", list.map((m) => `${m.memoryId} (${m.scope}): ${q(m.text)}`).join("\n")));

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

function memoryTools(server: McpServer, scope: RunScope, d: Deps): void {
  server.registerTool(
    "memory_list",
    { description: "What ion remembers for this project, and for the user.", inputSchema: {} },
    guard(() => {
      return memoryData(memoryView.list(d.db, scope.projectId));
    }),
  );
  server.registerTool(
    "memory_write",
    {
      description: "Remember something about this project for later chats. Keep it short and lasting.",
      inputSchema: { text: z.string().min(1).max(2000) },
    },
    guard(({ text }: { text: string }) => {
      // An agent can't flood a project's memory.
      if (d.grants.noteWrite(scope.runId) > WRITES_PER_RUN)
        throw new UserError("That's enough memory for one run");
      const source = { chatId: scope.chatId, runId: scope.runId };
      return ok(
        `Saved ${writeMemory(d.store, d.db, { scope: { projectId: scope.projectId }, text, source })}`,
      );
    }),
  );
}
