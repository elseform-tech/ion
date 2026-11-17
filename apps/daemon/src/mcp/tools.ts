import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UserError } from "../api/errors.js";
import { wrapData } from "../context/index.js";
import { writeMemory } from "../memory/index.js";
import { HISTORY_CHARS } from "../runs/history.js";
import type { Db, EventStore } from "../store/index.js";
import { chatsView } from "../views/chats.js";
import { memoryView } from "../views/memory.js";
import { messagesView } from "../views/messages.js";
import { needsView } from "../views/needs.js";
import type { Scope } from "./grants.js";

type Deps = { store: EventStore; db: Db };
type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

const SEARCH_MAX = 20;
const HIT_CHARS = 500;
const ok = (text: string): Result => ({ content: [{ type: "text", text }] });
const refuse = (text: string): Result => ({ content: [{ type: "text", text }], isError: true });
const q = (s: string) => JSON.stringify(s);

/** Runs a tool body; a refusal (UserError) becomes an error result the agent can read. */
const guard =
  <A>(f: (a: A) => Result) =>
  (a: A): Result => {
    try {
      return f(a);
    } catch (e) {
      if (e instanceof UserError) return refuse(e.message);
      throw e;
    }
  };

/** The tools a run gets, all limited to its own project. Everything they return is labelled as data. */
export function registerTools(server: McpServer, scope: Scope, d: Deps): void {
  historyTools(server, scope, d);
  memoryTools(server, scope, d);
}

function historyTools(server: McpServer, scope: Scope, d: Deps): void {
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
      const lines = messagesView.history(d.db, id, HISTORY_CHARS).slice(-(limit ?? 200));
      return ok(wrapData(`chat ${id}`, lines.map((m) => `${m.role}: ${q(m.text)}`).join("\n")));
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
      const lines = hits.map((h) => `${h.chatId} ${h.role}: ${q(h.text.slice(0, HIT_CHARS))}`);
      return ok(wrapData("search results", lines.join("\n")));
    }),
  );
  server.registerTool(
    "open_needs",
    { description: "What in this project is waiting on the user.", inputSchema: {} },
    guard(() => {
      const needs = needsView.open(d.db).filter((n) => n.projectId === scope.projectId);
      return ok(
        wrapData("open needs", needs.map((n) => `${n.needId} ${n.chatId}: ${q(n.summary)}`).join("\n")),
      );
    }),
  );
}

function memoryTools(server: McpServer, scope: Scope, d: Deps): void {
  server.registerTool(
    "memory_list",
    { description: "What ion remembers for this project, and for the user.", inputSchema: {} },
    guard(() => {
      const list = memoryView.list(d.db, scope.projectId);
      return ok(wrapData("memory", list.map((m) => `${m.memoryId} (${m.scope}): ${q(m.text)}`).join("\n")));
    }),
  );
  server.registerTool(
    "memory_write",
    {
      description: "Remember something about this project for later chats. Keep it short and lasting.",
      inputSchema: { text: z.string().min(1).max(2000) },
    },
    guard(({ text }: { text: string }) => {
      const source = { chatId: scope.chatId, runId: scope.runId };
      return ok(`Saved ${writeMemory(d.store, { scope: { projectId: scope.projectId }, text, source })}`);
    }),
  );
}
