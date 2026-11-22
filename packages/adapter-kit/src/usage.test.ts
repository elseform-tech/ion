import { describe, expect, it } from "vitest";
import { usageWindow } from "./usage.js";

describe("usageWindow", () => {
  it("names a window by its length and keeps its reset as a time", () => {
    expect(usageWindow(300, 62, 1795394159)).toEqual({
      name: "5 h",
      usedPercent: 62,
      resetsAt: new Date(1795394159 * 1000).toISOString(),
    });
    expect(usageWindow(10_080, 130, null)).toEqual({ name: "week", usedPercent: 100, resetsAt: null });
    expect(usageWindow(null, 5, 1)).toBeNull();
  });
});
