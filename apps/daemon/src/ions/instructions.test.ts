import { describe, expect, it } from "vitest";
import { ionInstructions } from "./instructions.js";

// Task 11, 2026-11-22 (live, Grok): a project's ion replied "I started a thread (chat_2cd70d64-…)": an id that says
// nothing to you. Ions name a thread by what it does, never by its id.
describe("what an ion is told", () => {
  it("never to show ids", () => {
    for (const id of ["chief", "shop"]) expect(ionInstructions(id)).toContain("never by its id");
  });
});

// The user, 2026-11-21: memory is small files; ions look there before asking, and keep one topic per file.
describe("what an ion is told about memory", () => {
  it("to look in memory first, and to update a file rather than add a near-copy", () => {
    for (const id of ["chief", "shop"]) {
      const told = ionInstructions(id);
      expect(told).toContain("before asking the user something you may already know.");
      expect(told).toContain(
        "Keep one topic per memory file; update a file (memory_read, then memory_write with its hash as expect) rather than adding a near-copy.",
      );
      expect(told).not.toContain("memory_list");
    }
  });
});

// The user, 2026-11-21: "does memory cover todo as well". Ions add a to-do only when you clearly mean it ("remind
// me to…", "later we need to…", a thread's last message listing what's left), with its date, and say so in one line.
describe("what an ion is told about to-dos", () => {
  it("to add one only when asked, with its date, and say it in one line", () => {
    for (const id of ["chief", "shop"]) {
      const told = ionInstructions(id);
      expect(told).toContain('"remind me to…", "later we need to…"');
      expect(told).toContain("a chat you started ends listing what's still to do");
      expect(told).toContain("memory_write with type todo");
      expect(told).toContain('"Added to your to-dos: <what> (<day>)"');
      // Task review, 2026-11-22: one wording, yours or a project's.
      expect(told).toContain(`"Added to <project>'s to-dos: <what> (<day>)" for a project's`);
      expect(told).toContain("never add one nobody asked for");
      expect(told).toContain("never mark one done yourself");
    }
  });
});
