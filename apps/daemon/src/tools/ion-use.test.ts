import { describe, expect, it } from "vitest";
import { ionMayUse, ionUseOf, setIonUse } from "./ion-use.js";

const RO = { readOnlyHint: true };
const search = { name: "search", description: "Search notes", annotations: RO };
const write = { name: "write", description: "Write a note", annotations: { readOnlyHint: true, destructiveHint: true } };
const plain = { name: "echo", description: "Echo it" };

// The user, 2026-11-21: "yes, add both to Task 10" — each server's tools get an "Ions can use" switch.
describe("Ions can use", () => {
  it("a tool labelled read-only starts on for ions; an unlabelled one starts off", () => {
    const { tools, seen } = ionUseOf([], "notes", [search, write, plain]);
    expect(tools.map((t) => [t.name, t.readOnly, t.ions])).toEqual([
      ["search", true, true],
      ["write", false, false],
      ["echo", false, false],
    ]);
    // What ion first saw is kept, so a later change is noticed.
    expect(seen).toHaveLength(3);
    expect(ionMayUse(seen, "notes", search)).toBe(true);
    expect(ionMayUse(seen, "notes", plain)).toBe(false);
  });

  it("your switch beats the label both ways", () => {
    let e = setIonUse([], "notes", search, false);
    e = setIonUse(e, "notes", plain, true);
    expect(ionMayUse(e, "notes", search)).toBe(false);
    expect(ionMayUse(e, "notes", plain)).toBe(true);
    const { tools } = ionUseOf(e, "notes", [search, plain]);
    expect(tools.map((t) => [t.name, t.ions, t.yours])).toEqual([
      ["search", false, false],
      ["echo", true, true],
    ]);
    // Another server's tool of the same name isn't touched.
    expect(ionMayUse(e, "other", plain)).toBe(false);
  });

  it("a changed tool turns off for ions", () => {
    const e = setIonUse(ionUseOf([], "notes", [search]).seen, "notes", plain, true);
    const search2 = { ...search, description: "Search notes and send them anywhere" };
    const plain2 = { ...plain, annotations: { destructiveHint: true } };
    expect(ionMayUse(e, "notes", search2)).toBe(false);
    expect(ionMayUse(e, "notes", plain2)).toBe(false);
    const { tools } = ionUseOf(e, "notes", [search2, plain2]);
    expect(tools.map((t) => [t.name, t.ions, t.changed])).toEqual([
      ["search", false, true],
      ["echo", false, true],
    ]);
    // Looking again (your switch) turns it back on as it is now.
    expect(ionMayUse(setIonUse(e, "notes", search2, true), "notes", search2)).toBe(true);
  });
});
