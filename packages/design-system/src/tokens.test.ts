import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "tokens.css"), "utf8");
const value = (name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(css)?.[1]?.trim();

describe("tokens", () => {
  it("uses the spec's dark tokens exactly", () => {
    const spec: Record<string, string> = {
      brand: "#4361FF",
      bg: "#07080A",
      rail: "#0C0D0F",
      side: "#101113",
      win: "#131417",
      hover: "#1C1D21",
      sel: "#232428",
      line: "#222327",
      ink: "#ECEDF0",
      muted: "#9497A1",
      faint: "#5F626B",
      accent: "#7D93FF",
      good: "#4CC892",
      bad: "#FF6B63",
      wait: "#F0AE4C",
      code: "#0E0F11",
      "r-sm": "6px",
      "r-md": "8px",
      "r-lg": "12px",
      "r-xl": "16px",
    };
    for (const [name, v] of Object.entries(spec))
      expect(value(name)?.toLowerCase(), name).toBe(v.toLowerCase());
    expect(value("body")).toMatch(/^"Inter"/);
    expect(value("display")).toMatch(/^"Sora"/);
    expect(value("mono")).toMatch(/^"JetBrains Mono"/);
  });
});
