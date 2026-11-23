import { EV } from "@ion/schema";
import type { createRunQueue } from "../scheduler/index.js";
import type { EventStore } from "../store/index.js";

/** How a run came: started by an ion, a handoff, the agent Pick by usage picked, and why it waits for a slot. */
export type How = { by?: "ion"; handoff?: true; routed?: string; waiting?: string };

/**
 * What a run is asked with besides its args. `request`: what the judge treats as your request, when the message
 * isn't yours as typed. `routed`: Pick by usage picked the agent, and why ("On Codex — Claude Code is near its limit").
 */
export type AskOpts = {
  request?: string;
  shown?: string;
  answers?: string;
  by?: "ion";
  title?: string;
  handoff?: true;
  routed?: string;
};

type Queue = ReturnType<typeof createRunQueue>;

/** Why a chat ion starts now would wait ("Waiting — 4 ion chats running"), or undefined when a slot is free. */
function waitLine(queue: Queue): string | undefined {
  if (!queue.full()) return undefined;
  const n = queue.running();
  return `Waiting — ${n} ion ${n === 1 ? "chat" : "chats"} running`;
}

/**
 * How this run came. The user, 2026-11-22: only chats ion starts (its threads, routines) wait for one of its slots,
 * and say why; yours start at once.
 */
export const howOf = (o: AskOpts, queue: Queue): How => ({
  ...{ by: o.by, handoff: o.handoff, routed: o.routed },
  waiting: o.by === "ion" ? waitLine(queue) : undefined,
});

/** After your message: why Pick by usage picked the agent (one line), then the run queued (and why it waits). */
export function queuedLines(
  store: EventStore,
  r: { chatId: string; runId: string; access: string; harness: string },
  how: How,
): void {
  const { chatId, runId } = r;
  if (how.routed) {
    const line = { kind: "routed", text: how.routed, to: r.harness };
    store.append({ chatId, runId: null, origin: "daemon", type: EV.chatHandoff, data: line });
  }
  const queued = { access: r.access, ...(how.waiting ? { waiting: how.waiting } : {}) };
  store.append({ chatId, runId, origin: "daemon", type: EV.runQueued, data: queued });
}
