import { describe, expect, it } from "vitest";
import { stripControl } from "./text.js";

// Security review, 2026-11-18: one definition for the CLI and the daemon, covering every invisible formatter.
describe("stripControl", () => {
  it("keeps newlines and tabs, and drops control characters, direction marks and invisible formatters", () => {
    const hidden = [
      "\u0000",
      "\u001b",
      "\u007f",
      "\u0085",
      "­",
      "؜",
      "᠎",
      "​",
      "‌",
      "‍",
      "‎",
      "‏",
      "‪",
      "‮",
      "⁠",
      "⁤",
      "⁦",
      "⁩",
      "﻿",
    ];
    expect(stripControl(`a${hidden.join("")}b\n\tc`)).toBe("ab\n\tc");
  });

  it("leaves ordinary text alone, accents and emoji included", () => {
    expect(stripControl("café — naïve 🚀 日本")).toBe("café — naïve 🚀 日本");
  });
});
