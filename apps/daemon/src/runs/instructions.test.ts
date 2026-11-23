import { describe, expect, it } from "vitest";
import { ionInstructions } from "./instructions.js";
import { runMcp } from "./servers.js";

const ION_INSTRUCTIONS = ionInstructions({ index: true });

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
    // Task review, 2026-11-22: a chat's to-do is its project's, so it says so.
    expect(ION_INSTRUCTIONS).toContain(`"Added to <project>'s to-dos: <what> (<day>)"`);
    expect(ION_INSTRUCTIONS).toContain("never add one nobody asked for");
    // Live (Grok), 2026-11-22: a chat closed the to-do it did; only the user does.
    expect(ION_INSTRUCTIONS).toContain("never mark one done: the user does");
  });
});

// The controller's end-to-end check, 2026-11-23: a chat's agent was told the memory index is "at the top of your first
// message" when there was none (no memory yet, or a resumed session); opencode remarked on it twice. It's said only
// when the index is there.
describe("what a run is told about the memory index", () => {
  it("says it's at the top only when it is", () => {
    expect(ionInstructions({ index: true })).toContain("its index is at the top of your first message");
    expect(ionInstructions({ index: false })).not.toContain("at the top");
    expect(ionInstructions({ index: false })).toContain("Look in ion's memory (memory_search, memory_read)");
    const ion = { url: "http://127.0.0.1:1/mcp", key: "k" };
    expect(runMcp({ ...ion, index: false }).instructions).not.toContain("at the top");
    expect(runMcp({ ...ion, index: true }).instructions).toContain("at the top");
  });
});
