import { EV } from "@ion/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserError } from "../api/errors.js";
import { EventStore, openDb } from "../store/index.js";
import { allViews } from "../views/index.js";
import { FollowUps } from "./followups.js";

let store: EventStore;
beforeEach(() => {
  vi.useFakeTimers();
  store = new EventStore(openDb(":memory:"), allViews);
});
afterEach(() => vi.useRealTimers());

const msg = { harness: "fake", text: "You chose Bankers.", request: "", shown: "Bankers" };

// Real run on Claude, 2026-11-19: you answered while the asking run was still ending its turn. The answer waited
// for the run to end, but at that moment the run manager still counted the run, so sending it read "busy", and
// nothing tried again: the answer never reached the agent.
describe("FollowUps", () => {
  it("sends a waiting answer once the chat is free, even if it still reads busy as its run ends", async () => {
    let busy = 2;
    const start = vi.fn(async () => {
      if (busy-- > 0) throw new UserError("This chat is already running");
      return "r2";
    });
    const f = new FollowUps(store, start, () => {});
    expect(await f.tryNow("c1", msg)).toBe("busy");
    f.later("c1", msg);
    store.append({
      chatId: "c1",
      runId: "r1",
      origin: "daemon",
      type: EV.runFinished,
      data: { status: "done" },
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(start).toHaveBeenCalledTimes(3);
    expect(start).toHaveBeenLastCalledWith("c1", msg);
  });
});
