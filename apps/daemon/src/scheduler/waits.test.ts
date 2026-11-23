import { describe, expect, it, vi } from "vitest";
import { Waits } from "./waits.js";

// Security scan, 2026-11-23: a reset that isn't a date (NaN) made `left <= 0` false and setTimeout(NaN) fire at once,
// again and again: a 1 ms spin. A time that isn't a date is never scheduled.
describe("Waits", () => {
  it("refuses a time that isn't a date", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const waits = new Waits();
    const fn = vi.fn();
    waits.at("c1", new Date("not a date"), fn);
    await new Promise((r) => setTimeout(r, 30));
    expect(fn).not.toHaveBeenCalled();
    expect(waits.has("c1")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    waits.stop();
    warn.mockRestore();
  });

  // Security scan follow-up, 2026-11-23: a refusal was silent (the chat had no wake-up) and said once per process. It
  // tells the caller (who falls back to ion's guess), and says so once per key.
  it("tells the caller it refused, and says so once per key", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const waits = new Waits();
    const bad = new Date(Number.NaN);
    expect(waits.at("a", bad, () => {})).toBe(false);
    expect(waits.at("a", bad, () => {})).toBe(false);
    expect(waits.at("b", bad, () => {})).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(waits.at("a", new Date(Date.now() + 60_000), () => {})).toBe(true);
    waits.stop();
    warn.mockRestore();
  });
});
