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

  // The user, 2026-11-19: opencode's avatar follows its logo (opencode.ai's mark): a tall frame, 4 wide to 5 high,
  // the top of its hollow open (the eyes look out there) and a block filling the rest.
  it("draws opencode as its logo's tall frame", () => {
    expect(botFor("opencode")).toMatchObject({ shape: "frame", decor: "opencode" });
    const xs: number[] = [];
    const ys: number[] = [];
    const rec = new Proxy({} as PathSink, {
      get: (_t, k) => (x?: number, y?: number, x2?: number, y2?: number) => {
        if (k === "closePath") return;
        for (const [a, b] of [
          [x, y],
          [x2, y2],
        ])
          if (typeof a === "number" && typeof b === "number") {
            xs.push(a);
            ys.push(b);
          }
      },
    });
    tracePath("frame", rec);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    expect(w / h).toBeCloseTo(0.8, 2);
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

// The lab's rail glyph: a hollow circle with its orbit, muted; ink and accent when Ions is open.
describe("railGlyph", () => {
  it("is a hollow circle with an orbit, brighter when on", async () => {
    const { railGlyph } = await import("./bots.js");
    const t = { win: "#000", ink: "#fff", muted: "#888", accent: "#7D93FF" };
    const off = railGlyph(false);
    const on = railGlyph(true);
    expect(off.shape).toBe("circle");
    expect(off.hollow?.(t)).toBe("#888");
    expect(on.hollow?.(t)).toBe("#fff");
    expect(on.orbit?.colors.map((c) => (typeof c === "function" ? c(t) : c))).toEqual(["#7D93FF"]);
  });
});
