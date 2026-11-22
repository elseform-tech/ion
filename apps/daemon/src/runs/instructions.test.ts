import { describe, expect, it } from "vitest";
import { ION_INSTRUCTIONS } from "./instructions.js";

// The user, 2026-11-21: memory is small files; chats look there before asking, keep one topic per file, and write
// what the next chat in the project should know.
describe("what a run is told about memory", () => {
  it("to look first, keep one topic per file, and write for the next chat", () => {
    for (const line of [
      "before asking the user something you may already know.",
      "Keep one topic per memory file; update a file (memory_read, then memory_write with its hash as expect) rather than adding a near-copy.",
      "With memory_write, write what the next chat in this project should know.",
    ])
      expect(ION_INSTRUCTIONS).toContain(line);
    expect(ION_INSTRUCTIONS).not.toContain("memory_list");
  });
});
