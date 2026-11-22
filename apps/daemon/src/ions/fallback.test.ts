import { describe, expect, it } from "vitest";
import { cleanWhy } from "./fallback.js";

// Security review, 2026-11-22: an agent's error went into the ion's reply and ion's log as it was. A key, a token or
// a link with a query string in it would have been shown. Only a short, clean line is.
describe("an agent's reason", () => {
  it("keeps plain words", () => {
    const why = "opencode's free usage is used up — try again later or pick another model";
    expect(cleanWhy(why)).toBe(why);
  });

  it("hides links, keys and tokens", () => {
    const key = ["sk", "ant", "api03", "Zx9Qw8Er7Ty6Ui5Op4As3Df2"].join("-");
    const why = `Failed at https://api.example.com/v1?token=abc123 with Bearer ${key} (api_key=hunter2Secret) ${"aB3".repeat(10)}`;
    const out = cleanWhy(why);
    for (const secret of ["api.example.com", "abc123", key, "hunter2Secret", "aB3aB3aB3"])
      expect(out).not.toContain(secret);
    expect(out).toContain("Failed at");
  });

  it("is one line of at most 200 characters", () => {
    const out = cleanWhy(`first line\nsecond ${"word ".repeat(100)}`);
    expect(out).not.toContain("\n");
    expect(out.length).toBeLessThanOrEqual(200);
  });
});
