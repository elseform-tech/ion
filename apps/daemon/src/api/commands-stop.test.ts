import { EV } from "@ion/schema";
import { expect, it, vi } from "vitest";
import { EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { type Ctx, handlers } from "./commands.js";

// Re-review, 2026-11-23 (untested before): Stop on a chat (its try after a limit's reset, say) also ends the chat's
// wait for its agent's reset, so it doesn't go on by itself later.
it("Stop ends the chat's wait for its agent's reset", async () => {
  const store = new EventStore(openDb(":memory:"), allViews);
  store.append({ chatId: "c1", runId: "r1", origin: "daemon", type: EV.runQueued, data: {} });
  const cancel = vi.fn();
  const ctx = {
    store,
    queue: { hold: vi.fn() },
    handoffs: { cancel },
    runs: { interrupt: vi.fn(async () => {}) },
  } as unknown as Ctx;
  await handlers["run.interrupt"]({ runId: "r1" }, ctx);
  expect(cancel).toHaveBeenCalledWith("c1");
});
