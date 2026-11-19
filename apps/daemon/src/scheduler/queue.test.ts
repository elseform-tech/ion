import { describe, expect, it } from "vitest";
import { createRunQueue, maxRuns } from "./queue.js";

const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => {
    open = r;
  });
  return { p, open };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createRunQueue", () => {
  it("with limit 1, runs three items one after another, in order", async () => {
    const q = createRunQueue(1);
    const order: string[] = [];
    const gates = [gate(), gate(), gate()];
    gates.forEach((g, i) =>
      q.enqueue(async () => {
        order.push(`start${i}`);
        await g.p;
      }),
    );
    await tick();
    expect(order).toEqual(["start0"]);
    expect(q.size()).toBe(2);
    gates[0]!.open();
    await tick();
    expect(order).toEqual(["start0", "start1"]);
    gates[1]!.open();
    await tick();
    expect(order).toEqual(["start0", "start1", "start2"]);
  });

  it("never starts a cancelled item, and moves on to the next", async () => {
    const q = createRunQueue(1);
    const first = gate();
    const started: number[] = [];
    q.enqueue(async () => {
      started.push(0);
      await first.p;
    });
    const second = q.enqueue(async () => {
      started.push(1);
    });
    q.enqueue(async () => {
      started.push(2);
    });
    expect(second.cancel()).toBe(true);
    first.open();
    await tick();
    await tick();
    expect(started).toEqual([0, 2]);
  });

  it("frees the slot when a start fails", async () => {
    const q = createRunQueue(1);
    const started: number[] = [];
    q.enqueue(async () => {
      throw new Error("boom");
    });
    q.enqueue(async () => {
      started.push(1);
    });
    await tick();
    await tick();
    expect(started).toEqual([1]);
  });
});

describe("maxRuns", () => {
  it('"auto" is half the cores, at least one', () => {
    expect(maxRuns("auto", 8)).toBe(4);
    expect(maxRuns("auto", 1)).toBe(1);
    expect(maxRuns("auto", 3)).toBe(1);
    expect(maxRuns(6, 8)).toBe(6);
  });
});

// The user, 2026-11-19 (Settings): a changed max_runs applies to the run queue without a restart.
describe("a limit read at each start", () => {
  it("lets waiting starts go when the limit grows", async () => {
    let limit = 1;
    const q = createRunQueue(() => limit);
    const started: number[] = [];
    const hold = () => new Promise<void>(() => {});
    q.enqueue(() => (started.push(1), hold()));
    q.enqueue(() => (started.push(2), hold()));
    await new Promise((r) => setTimeout(r, 5));
    expect(started).toEqual([1]);
    limit = 2;
    q.kick();
    await new Promise((r) => setTimeout(r, 5));
    expect(started).toEqual([1, 2]);
  });
});
