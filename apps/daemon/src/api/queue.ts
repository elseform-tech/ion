import { targetOf } from "../queue/index.js";
import type { Handlers } from "./commands.js";

/** Your next messages to a chat or an ion while it works (Plan 16), and Esc twice for an ion. */
export const queueHandlers: Pick<
  Handlers,
  "queue.list" | "queue.add" | "queue.remove" | "queue.take" | "queue.sendNow" | "ion.stop"
> = {
  "queue.list": (a, ctx) => ctx.queue.list(targetOf(a.to)),
  "queue.add": (a, ctx) => ({
    queueId: ctx.queue.add(targetOf(a.to), String(a.text ?? ""), a.brain ?? {}),
  }),
  "queue.remove": (a, ctx) => {
    ctx.queue.remove(String(a.queueId ?? ""));
    return { ok: true as const };
  },
  "queue.take": (a, ctx) => ctx.queue.take(String(a.queueId ?? "")),
  "queue.sendNow": async (a, ctx) => {
    await ctx.queue.sendNow(String(a.queueId ?? ""));
    return { ok: true as const };
  },
  "ion.stop": (a, ctx) => {
    ctx.ions.stopTurn(String(a.ionId ?? ""));
    return { ok: true as const };
  },
};
