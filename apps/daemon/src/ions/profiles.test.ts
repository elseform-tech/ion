import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { profileOf, rankProjects } from "./profiles.js";

const dir = (readme?: string) => {
  const d = mkdtempSync(join(tmpdir(), "ion-profile-"));
  if (readme !== undefined) writeFileSync(join(d, "README.md"), readme);
  return d;
};

// The user, 2026-11-19: with 20 projects, ion chief must know what each one is to send work to the right one.
describe("profileOf", () => {
  it("profile is the config's, else the README's first paragraph, at most 300 characters", () => {
    const path = dir("# Shop\n\n![badge](x.svg)\n\nThe online shop:\ncart and checkout.\n\nMore later.\n");
    expect(profileOf({ id: "a", path, starred: false, profile: "Mine\u0007 own" })).toBe("Mine own");
    expect(profileOf({ id: "a", path, starred: false })).toBe("The online shop: cart and checkout.");
    expect(
      profileOf({ id: "a", path: dir(`${"word ".repeat(100)}\u001b[31m`), starred: false }),
    ).toHaveLength(300);
    expect(profileOf({ id: "a", path: dir(), starred: false })).toBe("");
    expect(profileOf({ id: "a", path: "/nowhere/at/all", starred: false })).toBe("");
  });
});

describe("rankProjects", () => {
  it("rankProjects puts the project whose profile matches first", () => {
    const projects = Array.from({ length: 20 }, (_, i) => ({
      id: `p${i}`,
      profile: `Project number ${i} about docs`,
      titles: ["Fix the build"],
    }));
    // Most recent first: storefront comes last, so only its words can put it first.
    projects.push({ id: "storefront", profile: "The shop's cart and checkout pages", titles: [] });
    projects.splice(3, 0, { id: "billing", profile: "Invoices", titles: ["Checkout totals are wrong"] });
    const ranked = rankProjects("cart checkout", projects);
    expect(ranked[0]).toBe("storefront");
    expect(ranked[1]).toBe("billing");
    expect(ranked).toHaveLength(10);
    // Ties keep the order given (most recent activity first).
    expect(ranked.slice(2, 4)).toEqual(["p0", "p1"]);
  });
});
