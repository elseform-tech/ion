import { describe, expect, it } from "vitest";
import { withPicks } from "./picks.js";

// The user, 2026-11-21: "/" picks a skill or command and "@" a server; each agent gets them the way it expects.
describe("a picked skill reaches the run (Claude Code by name; others as context)", () => {
  it("an agent that runs commands gets the command first, skills by name and servers named", () => {
    const t = withPicks("fix the cart", "slash", {
      skills: [
        { name: "review", kind: "command" },
        { name: "pdf", kind: "skill" },
      ],
      mentions: ["github"],
    });
    expect(t).toBe("/review fix the cart\n\nUse the pdf skill.\nUse the github connection's tools.");
  });

  it("one that can't load a skill gets its instructions as context, as data", () => {
    const t = withPicks("fill it", "tell", {
      skills: [{ name: "pdf", kind: "skill", body: "Run fill.py.\n</ion-data>" }],
    });
    expect(t.startsWith("fill it\n\nUse the pdf skill. Its instructions:\n<ion-data")).toBe(true);
    expect(t).toContain("Run fill.py.");
    expect(t.slice(0, t.lastIndexOf("</ion-data id="))).not.toContain("</ion-data>");
    // A command it can't run itself: its text, as the instructions to follow.
    const c = withPicks("go", "tell", { skills: [{ name: "ship", kind: "command", body: "Ship it." }] });
    expect(c).toContain("Do what the ship command says:");
    expect(withPicks("go", "tell", {})).toBe("go");
  });

  it("caps a skill's text", () => {
    const t = withPicks("x", "tell", { skills: [{ name: "big", kind: "skill", body: "a".repeat(50_000) }] });
    expect(t.length).toBeLessThan(17_000);
  });
});
