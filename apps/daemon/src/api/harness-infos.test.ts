import type { HarnessInfo } from "@ion/schema";
import { describe, expect, it, vi } from "vitest";
import { HarnessInfos } from "./harness-infos.js";

const info = (id: string, n: number): HarnessInfo => ({
  id,
  label: `${id} ${n}`,
  installed: true,
  signedIn: true,
  models: [],
  defaultModel: null,
});

// The user, 2026-11-18: the model picker waited on every agent's CLI (Claude's model list is slow).
describe("HarnessInfos", () => {
  it("answers from what it knows at once, and reads again in the background once it's old", async () => {
    let now = 0;
    let n = 0;
    const load = vi.fn(async (id: string) => info(id, ++n));
    const infos = new HarnessInfos(["a"], load, { maxAgeMs: 60_000, now: () => now });
    expect((await infos.list())[0]!.label).toBe("a 1");
    expect((await infos.list())[0]!.label).toBe("a 1");
    expect(load).toHaveBeenCalledTimes(1);
    now = 61_000;
    expect((await infos.list())[0]!.label).toBe("a 1"); // still at once; a new read starts
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect((await infos.list())[0]!.label).toBe("a 2");
  });

  // The user, 2026-11-21: `ion status` shows each agent's usage line, and never waits on an agent's CLI for it.
  it("says what it knows now without waiting, and starts a first read", async () => {
    const load = vi.fn(async (id: string) => info(id, 1));
    const infos = new HarnessInfos(["a"], load);
    expect(infos.cached()).toEqual([]);
    await vi.waitFor(() => expect(infos.cached().map((h) => h.id)).toEqual(["a"]));
    expect(load).toHaveBeenCalledTimes(1);
  });

  // Review, 2026-11-22: the first `ion status` after a daemon start had no agent lines (nothing read yet). It waits for
  // the first reads, a few seconds at most.
  it("waits a little for the first reads, never longer", async () => {
    const quick = new HarnessInfos(["a"], async (id) => {
      await new Promise((r) => setTimeout(r, 50));
      return info(id, 1);
    });
    expect((await quick.settled(2000)).map((h) => h.id)).toEqual(["a"]);
    const stuck = new HarnessInfos(["b"], () => new Promise<HarnessInfo>(() => {}));
    const t0 = Date.now();
    expect(await stuck.settled(100)).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1000);
    // Only a fresh start waits: once its few seconds are over, every later ask answers at once (pnpm check,
    // 2026-11-22: each `ion status` waited again on a slow agent).
    const t1 = Date.now();
    expect(await stuck.settled(100)).toEqual([]);
    expect(Date.now() - t1).toBeLessThan(150);
  });

  it("doesn't wait on a slow agent once it knows it", async () => {
    let slow: (v: HarnessInfo) => void = () => {};
    const load = vi.fn((id: string) =>
      id === "b" && load.mock.calls.length > 2
        ? new Promise<HarnessInfo>((r) => (slow = r))
        : Promise.resolve(info(id, 1)),
    );
    let now = 0;
    const infos = new HarnessInfos(["a", "b"], load, { maxAgeMs: 10, now: () => now });
    await infos.list();
    now = 100;
    const list = await infos.list();
    expect(list.map((x) => x.id)).toEqual(["a", "b"]);
    slow(info("b", 2));
  });
  // The user, 2026-11-18: Claude's models still showed late. The warm-up's first read wasn't kept, so the first
  // list started a second, slow read of its own.
  it("lets the first list wait on the warm-up's read, not start another", async () => {
    let done: (h: HarnessInfo) => void = () => {};
    const load = vi.fn(() => new Promise<HarnessInfo>((r) => (done = r)));
    const infos = new HarnessInfos(["claude"], load);
    infos.warm();
    const listed = infos.list();
    done(info("claude", 1));
    expect((await listed)[0]!.label).toBe("claude 1");
    expect(load).toHaveBeenCalledTimes(1);
  });
});
