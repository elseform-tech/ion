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

// The user, 2026-11-21: "does memory cover todo as well". A chat adds a to-do for its project only when you clearly
// ask, and says so in one line.
describe("what a run is told about to-dos", () => {
  it("to add one only when asked, for its project, and say it in one line", () => {
    expect(ION_INSTRUCTIONS).toContain('"remind me to…"');
    expect(ION_INSTRUCTIONS).toContain('type todo and scope "project"');
    expect(ION_INSTRUCTIONS).toContain('"Added to your to-dos: <what> (<day>)"');
    expect(ION_INSTRUCTIONS).toContain("never add one nobody asked for");
    // Live (Grok), 2026-11-22: a chat closed the to-do it did; only the user does.
    expect(ION_INSTRUCTIONS).toContain("never mark one done: the user does");
  });
});
