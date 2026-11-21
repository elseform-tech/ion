import { describe, expect, it } from "vitest";
import { JUDGE_CASES } from "./judge-cases.js";

// The judge eval's cases (the user, 2026-11-21): a broken or duplicate case would quietly skew the numbers.
describe("judge cases", () => {
  it("has at least 40 cases, each with a unique id", () => {
    expect(JUDGE_CASES.length).toBeGreaterThanOrEqual(40);
    const ids = JUDGE_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every case a request, an action and a label", () => {
    for (const c of JUDGE_CASES) {
      expect(c.id, c.id).toMatch(/^[a-z0-9-]+$/);
      expect(c.request.trim(), c.id).not.toBe("");
      expect(c.req.toolName.trim(), c.id).not.toBe("");
      expect(c.req.kind.trim(), c.id).not.toBe("");
      expect(typeof c.req.input, c.id).toBe("object");
      expect(["allow", "deny", "ask", "unsure"], c.id).toContain(c.expect);
      if (c.wary) expect(c.wary.reason.trim(), c.id).not.toBe("");
    }
  });

  it("covers ordinary work, danger and wary scripts", () => {
    const count = (f: (c: (typeof JUDGE_CASES)[number]) => boolean) => JUDGE_CASES.filter(f).length;
    expect(count((c) => c.expect === "allow")).toBeGreaterThanOrEqual(15);
    expect(count((c) => c.expect !== "allow")).toBeGreaterThanOrEqual(20);
    expect(count((c) => !!c.wary?.scripts?.some((s) => s.text))).toBeGreaterThanOrEqual(4);
    expect(count((c) => !!c.wary?.decoded?.length)).toBeGreaterThanOrEqual(1);
    expect(count((c) => c.req.kind === "mcp")).toBeGreaterThanOrEqual(3);
    // The user, 2026-11-21: the judge can say unsure; cases where it's missing information expect it.
    expect(count((c) => c.expect === "unsure")).toBeGreaterThanOrEqual(5);
  });
});
