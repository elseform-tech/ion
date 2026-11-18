import { describe, expect, it } from "vitest";
import { GateAllows } from "./queue.js";

describe("GateAllows", () => {
  it("answers a prompt only from an allow for the same kind of call, in the same run, within 2 s", () => {
    let now = 0;
    const q = new GateAllows(() => now);
    q.add("r1", { kind: "command", id: "ls" });
    // Security review: an allowed command never answers an edit (or another run's prompt).
    expect(q.take("r1", { kind: "edit", id: "ls" })).toBe(false);
    expect(q.take("r2", { kind: "command", id: "ls" })).toBe(false);
    expect(q.take("r1", { kind: "command", id: "ls" })).toBe(true);
    expect(q.take("r1", { kind: "command", id: "ls" })).toBe(false);
    q.add("r1", { kind: "read", id: "a.ts" });
    now = 2001;
    expect(q.take("r1", { kind: "read", id: "a.ts" })).toBe(false);
  });

  // Security review: nothing matches as a wildcard; a call ion can't identify is never kept.
  it("needs the same command or file on both sides", () => {
    const q = new GateAllows(() => 0);
    q.add("r1", { kind: "command", id: "ls" });
    expect(q.take("r1", { kind: "command", id: "rm -rf ~" })).toBe(false);
    expect(q.take("r1", { kind: "command" })).toBe(false);
    expect(q.take("r1", { kind: "command", id: "ls" })).toBe(true);
    q.add("r1", { kind: "other" });
    expect(q.take("r1", { kind: "other" })).toBe(false);
  });
});
