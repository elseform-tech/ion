import { describe, expect, it } from "vitest";
import { botFor, type PathSink, tracePath } from "./bots.js";

/** Records the path calls a shape makes, instead of drawing them. */
function recorder(): PathSink & { calls: string[] } {
  const calls: string[] = [];
  const rec =
    (name: string) =>
    (...a: number[]) =>
      void calls.push(`${name}(${a.map((x) => x.toFixed(3)).join(",")})`);
  return {
    calls,
    moveTo: rec("moveTo"),
    lineTo: rec("lineTo"),
    arc: rec("arc"),
    ellipse: rec("ellipse"),
    bezierCurveTo: rec("bezierCurveTo"),
    quadraticCurveTo: rec("quadraticCurveTo"),
    closePath: () => void calls.push("closePath"),
    rect: rec("rect"),
  };
}

// Plan 08: avatars as the lab draws them; the shape follows the harness only.
describe("bots", () => {
  it("gives each harness the lab's shape", () => {
    expect(botFor("claude-code").shape).toBe("spark");
    expect(botFor("grok-build").shape).toBe("circle");
    expect(botFor("codex").shape).toBe("hexflower");
    expect(botFor("gemini").shape).toBe("gem");
    expect(botFor("cursor").shape).toBe("cube");
  });

  it("draws a plain orb for a harness the lab doesn't have", () => {
    expect(botFor("opencode").shape).toBe("circle");
    expect(botFor("anything-else").shape).toBe("circle");
  });

  it("traces each shape as the lab does", () => {
    const shapes = ["circle", "spark", "hexflower", "gem", "cube"] as const;
    const traced = shapes.map((s) => {
      const r = recorder();
      tracePath(s, r);
      return r.calls.join(";");
    });
    for (const t of traced) expect(t.length).toBeGreaterThan(0);
    expect(new Set(traced).size).toBe(shapes.length);
    const circle = recorder();
    tracePath("circle", circle);
    expect(circle.calls).toEqual([`arc(0.000,0.000,1.000,0.000,${(Math.PI * 2).toFixed(3)})`]);
  });
});
