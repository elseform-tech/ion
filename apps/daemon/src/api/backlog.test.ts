import { EV } from "@ion/schema";
import { describe, expect, it } from "vitest";
import { EventStore, openDb } from "../store/index.js";
import { readBacklog } from "./backlog.js";

// Regression (final review I2): subscribe used to stop at the first 10,000 events.
describe("readBacklog", () => {
  it("returns every event past the cursor, across pages", () => {
    const store = new EventStore(openDb(":memory:"));
    const ids = Array.from(
      { length: 7 },
      (_, i) =>
        store.append({
          chatId: `c${i}`,
          runId: null,
          origin: "daemon",
          type: EV.chatCreated,
          data: { title: "t", projectId: null },
        }).id,
    );
    expect(readBacklog(store, {}, 3).map((e) => e.id)).toEqual(ids);
    expect(readBacklog(store, { afterId: ids[1] }, 2).map((e) => e.id)).toEqual(ids.slice(2));
  });
});
