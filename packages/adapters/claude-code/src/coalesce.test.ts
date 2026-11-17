import { describe, expect, it } from "vitest";
import { createDeltaCoalescer } from "./coalesce.js";

describe("createDeltaCoalescer", () => {
  it("batches many small deltas into few flushes without losing text", async () => {
    const flushes: string[] = [];
    const c = createDeltaCoalescer((t) => flushes.push(t));
    const started = performance.now();
    for (let i = 0; i < 5000; i++) c.push("x");
    c.end();
    expect(flushes.join("")).toBe("x".repeat(5000));
    expect(flushes.length).toBeLessThan(10);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("flushes when the buffer reaches the byte limit", () => {
    const flushes: string[] = [];
    const c = createDeltaCoalescer((t) => flushes.push(t), { ms: 10_000, bytes: 4 });
    c.push("ab");
    c.push("cd");
    expect(flushes).toEqual(["abcd"]);
    c.end();
  });

  it("flushes after the time limit", async () => {
    const flushes: string[] = [];
    const c = createDeltaCoalescer((t) => flushes.push(t), { ms: 10 });
    c.push("hi");
    await new Promise((r) => setTimeout(r, 30));
    expect(flushes).toEqual(["hi"]);
    c.end();
  });

  it("does nothing on end with an empty buffer", () => {
    const flushes: string[] = [];
    createDeltaCoalescer((t) => flushes.push(t)).end();
    expect(flushes).toEqual([]);
  });
});
