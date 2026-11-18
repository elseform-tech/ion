import { describe, expect, it } from "vitest";
import { GateAllows } from "./queue.js";

describe("GateAllows", () => {
  it("answers a prompt only from an allow for the same kind of call, in the same run, within 2 s", () => {
    let now = 0;
    const q = new GateAllows(() => now);
    q.add("r1", { kind: "command" });
    // Security review: an allowed command never answers an edit (or another run's prompt).
    expect(q.take("r1", { kind: "edit" })).toBe(false);
    expect(q.take("r2", { kind: "command" })).toBe(false);
    expect(q.take("r1", { kind: "command" })).toBe(true);
    expect(q.take("r1", { kind: "command" })).toBe(false);
    q.add("r1", { kind: "read" });
    now = 2001;
    expect(q.take("r1", { kind: "read" })).toBe(false);
  });

  it("needs the same command when both sides name one", () => {
    const q = new GateAllows(() => 0);
    q.add("r1", { kind: "command", command: "ls" });
    expect(q.take("r1", { kind: "command", command: "rm -rf ~" })).toBe(false);
    expect(q.take("r1", { kind: "command", command: "ls" })).toBe(true);
  });
});
