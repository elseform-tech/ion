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

  // Task review, 2026-11-21: a resource you picked with "@".
  it("names a picked resource by its server and URI", () => {
    expect(withPicks("x", "tell", { mentions: ["notes resource file:///a"] })).toBe(
      "x\n\nRead the notes resource file:///a.",
    );
  });
});

// The user, 2026-11-22: picks sit in the sentence where you typed them ("use /review on this, then /pdf"). A command
// already leading the text isn't put in front again; a skill leading it isn't sent as a command the agent can't run.
describe("picks in the sentence", () => {
  it("a command already at the start leads once; a skill at the start loses its slash", () => {
    const review = { name: "review", kind: "command" as const };
    const pdf = { name: "pdf", kind: "skill" as const };
    expect(withPicks("/review on this, then /pdf", "slash", { skills: [review, pdf] })).toBe(
      "/review on this, then /pdf\n\nUse the pdf skill.",
    );
    expect(withPicks("/pdf this, then /review", "slash", { skills: [pdf, review] })).toBe(
      "/review pdf this, then /review\n\nUse the pdf skill.",
    );
    expect(withPicks("/pdf it", "tell", { skills: [pdf] })).toBe("pdf it\n\nUse the pdf skill.");
  });
});
