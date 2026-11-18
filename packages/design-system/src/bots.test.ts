import { describe, expect, it } from "vitest";
import { botFor, ionBot, type PathSink, tracePath } from "./bots.js";

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

  // The user, 2026-11-18: opencode gets its own avatar from its logo (a square block with a square inside).
  it("draws opencode as a square block with its inner square", () => {
    expect(botFor("opencode")).toMatchObject({ shape: "block", decor: "opencode" });
    const calls: string[] = [];
    const rec = new Proxy({} as PathSink, { get: (_t, k) => () => calls.push(String(k)) });
    tracePath("block", rec);
    expect(calls.filter((c) => c === "closePath")).toHaveLength(1);
  });

  it("draws a plain orb for a harness the lab doesn't have", () => {
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

// Plan 09: ions. A project's ion is its harness's shape in the project's colour; ion chief is the ink orbit bot.
describe("ionBot", () => {
  it("draws a project's ion as its harness's shape in the project's colour", () => {
    expect(ionBot({ harness: "claude-code", color: "#5BC67A" })).toMatchObject({
      shape: "spark",
      color: "#5BC67A",
    });
    expect(ionBot({ harness: "grok-build", color: "#3C82F6" })).toMatchObject({
      shape: "circle",
      color: "#3C82F6",
      decor: "grok",
    });
  });

  it("draws an ion with an unknown or no harness as a circle in its colour", () => {
    expect(ionBot({ harness: null, color: "#F19D38" })).toMatchObject({ shape: "circle", color: "#F19D38" });
  });

  it("draws ion chief as the ink circle with an orbit of three colours", () => {
    const chief = ionBot("chief");
    expect(chief.shape).toBe("circle");
    expect(chief.orbit).toMatchObject({ tilt: -0.42, speed: 1.1, colors: ["#D97757", "#4285F4", "#5BC67A"] });
  });
});
