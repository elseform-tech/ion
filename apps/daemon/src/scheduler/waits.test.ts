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
});
