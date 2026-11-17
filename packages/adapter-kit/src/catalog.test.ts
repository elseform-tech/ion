import { describe, expect, it, vi } from "vitest";
import { cachedCatalog } from "./catalog.js";

const live = { models: [{ id: "m1", label: "M1" }], defaultModel: "m1" };
const fallback = { models: [{ id: "alias", label: "Alias" }], defaultModel: null };

describe("cachedCatalog", () => {
  it("loads once and keeps the list for 10 minutes", async () => {
    let now = 0;
    const load = vi.fn(async () => live);
    const get = cachedCatalog(load, { fallback, now: () => now });
    expect(await get()).toEqual({ ...live, live: true });
    now = 9 * 60_000;
    await get();
    expect(load).toHaveBeenCalledTimes(1);
    now = 11 * 60_000;
    await get();
    expect(load).toHaveBeenCalledTimes(2);
  });

  // Review Focus 5: a harness whose catalog can't be read.
  it("falls back when loading fails or takes too long, and tries again a minute later", async () => {
    let now = 0;
    const failing = vi.fn(async () => {
      throw new Error("signed out");
    });
    const get = cachedCatalog(failing, { fallback, now: () => now });
    expect(await get()).toEqual({ ...fallback, live: false });
    now = 30_000;
    await get();
    expect(failing).toHaveBeenCalledTimes(1);
    now = 61_000;
    await get();
    expect(failing).toHaveBeenCalledTimes(2);
    const slow = cachedCatalog(() => new Promise<typeof live>(() => {}), { fallback, timeoutMs: 20 });
    expect(await slow()).toEqual({ ...fallback, live: false });
  });

  it("shares one load between callers that ask at the same time", async () => {
    const load = vi.fn(async () => live);
    const get = cachedCatalog(load, { fallback });
    await Promise.all([get(), get(), get()]);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
