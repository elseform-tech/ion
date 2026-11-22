import { describe, expect, it } from "vitest";
import { checkLines } from "./tool-verbs.js";

// The user, 2026-11-21 ("sure"): ion's commands manage ion's layer, used on every agent; doctor and verify also check
// agents' own servers and skills, read-only, and say whose they are.
describe("a check's lines", () => {
  it("says an agent's own, checked read-only", () => {
    const c = {
      kind: "mcp" as const,
      name: "gh",
      id: "codex:gh",
      on: true,
      agent: "codex",
      problems: ["Needs sign-in"],
    };
    expect(checkLines(c)).toBe("gh  Codex's own\n  Needs sign-in");
  });

  it("is as before for one of ion's", () => {
    const c = { kind: "mcp" as const, name: "docs", id: "docs", on: false, problems: [] };
    expect(checkLines(c)).toMatch(/^docs {2}off *$/);
  });
});
