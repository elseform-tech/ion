import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "./connection.js";
import { silence } from "./session.js";

afterEach(() => vi.useRealTimers());

// Task review, 2026-11-21: a tool call whose update never came (the agent lost it) paused the silence check for good,
// and a stuck run waited forever. A running tool pauses the check for at most 30 minutes; then the check goes on.
describe("the silence check and a tool that never completes", () => {
  it("pauses for at most 30 minutes, then the check resumes", () => {
    vi.useFakeTimers();
    const failed: string[] = [];
    const quiet = silence({ ms: 60_000, why: "quiet" }, {} as Connection, (w) => failed.push(w));
    quiet.heard();
    quiet.pause("tool:t1", 30 * 60_000);
    vi.advanceTimersByTime(29 * 60_000);
    expect(failed).toEqual([]);
    vi.advanceTimersByTime(60_000 + 60_000 + 10);
    expect(failed).toEqual(["quiet"]);
  });

  it("ion holding a call has no such limit", () => {
    vi.useFakeTimers();
    const failed: string[] = [];
    const quiet = silence({ ms: 60_000, why: "quiet" }, {} as Connection, (w) => failed.push(w));
    quiet.pause("ion");
    vi.advanceTimersByTime(60 * 60_000);
    expect(failed).toEqual([]);
  });
});
