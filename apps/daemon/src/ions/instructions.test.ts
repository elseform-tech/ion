import { describe, expect, it } from "vitest";
import { ionInstructions } from "./instructions.js";

// Task 11, 2026-11-22 (live, Grok): a project's ion replied "I started a thread (chat_2cd70d64-…)": an id that says
// nothing to you. Ions name a thread by what it does, never by its id.
describe("what an ion is told", () => {
  it("never to show ids", () => {
    for (const id of ["chief", "shop"]) expect(ionInstructions(id)).toContain("never by its id");
  });
});
