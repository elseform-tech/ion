import { describe, expect, it } from "vitest";
import { GateAllows } from "./queue.js";

describe("GateAllows", () => {
  it("answers a prompt only from an allow for the same kind of call, in the same run, within 10 s", () => {
    let now = 0;
    const q = new GateAllows(() => now);
    q.add("r1", "command");
    // Security review: an allowed command never answers an edit (or another run's prompt).
    expect(q.take("r1", "edit")).toBe(false);
    expect(q.take("r2", "command")).toBe(false);
    expect(q.take("r1", "command")).toBe(true);
    expect(q.take("r1", "command")).toBe(false);
    q.add("r1", "read");
    now = 10_001;
    expect(q.take("r1", "read")).toBe(false);
  });
});
