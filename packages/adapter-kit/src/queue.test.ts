import { describe, expect, it } from "vitest";
import { createEventQueue } from "./queue.js";

const drain = async <T>(it: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

describe("createEventQueue", () => {
  it("yields pushed items in order and finishes on end", async () => {
    const q = createEventQueue<number>();
    q.push(1);
    q.push(2);
    setTimeout(() => {
      q.push(3);
      q.end();
    }, 5);
    expect(await drain(q)).toEqual([1, 2, 3]);
  });

  it("ignores pushes after end", async () => {
    const q = createEventQueue<number>();
    q.push(1);
    q.end();
    q.push(2);
    expect(await drain(q)).toEqual([1]);
  });

  it("rejects the iterator on fail, after earlier items", async () => {
    const q = createEventQueue<number>();
    q.push(1);
    q.fail(new Error("boom"));
    const it = q[Symbol.asyncIterator]();
    expect(await it.next()).toEqual({ value: 1, done: false });
    await expect(it.next()).rejects.toThrow("boom");
  });
});
