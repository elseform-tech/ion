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
});
