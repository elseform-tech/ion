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
