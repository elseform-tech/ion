import { randomBytes } from "node:crypto";
import { EV } from "@ion/schema";
import { UserError } from "../api/errors.js";
import type { Db, EventStore } from "../store/index.js";
import { memoryView } from "../views/memory.js";

export type MemoryWrite = {
  scope: "you" | { projectId: string };
  text: string;
  source: "you" | { chatId: string; runId: string };
};

const MAX = 2000;

/** Remembers something; returns its id. */
export function writeMemory(store: EventStore, m: MemoryWrite): string {
  const text = m.text.trim();
  if (!text) throw new UserError("A memory can't be empty");
  if (text.length > MAX) throw new UserError(`A memory can be ${MAX} characters at most`);
  const memoryId = `m${randomBytes(3).toString("hex")}`;
  store.append({
    chatId: null,
    runId: null,
    origin: "daemon",
    type: EV.memoryWritten,
    data: { ...m, text, memoryId },
  });
  return memoryId;
}

export function forgetMemory(store: EventStore, db: Db, memoryId: string): void {
  if (!memoryView.has(db, memoryId)) throw new UserError(`Unknown memory: ${memoryId}`);
  store.append({ chatId: null, runId: null, origin: "daemon", type: EV.memoryForgotten, data: { memoryId } });
}
