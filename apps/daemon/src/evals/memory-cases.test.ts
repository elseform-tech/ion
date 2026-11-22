import { MEMORY_PATH, MEMORY_TYPES } from "@ion/schema";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MEMORY_CASES, MEMORY_MEASURES } from "./memory-cases.js";
import { fillerSeeds, upFrontOfSeeds } from "./memory-seeds.js";

// The memory eval's cases (Task 5, 2026-11-22): a broken seed or a case that can't fail would quietly skew the numbers.
describe("memory cases", () => {
  it("gives every case a unique id, a question, and seeds that are memory files", () => {
    const ids = MEMORY_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of MEMORY_CASES) {
      expect(c.id, c.id).toMatch(/^[a-z0-9-]+$/);
      expect(c.text.trim(), c.id).not.toBe("");
      for (const s of c.seeds) {
        expect(s.path, c.id).toMatch(MEMORY_PATH);
        expect(MEMORY_TYPES, c.id).toContain(s.header.type);
        expect(s.header.name?.trim(), c.id).toBeTruthy();
        expect(s.header.description?.trim(), c.id).toBeTruthy();
        expect(s.text.trim(), c.id).not.toBe("");
      }
      expect(new Set(c.seeds.map((s) => s.path)).size, c.id).toBe(c.seeds.length);
    }
  });

  it("covers every measure at least twice, and each case can pass or fail", () => {
    for (const m of MEMORY_MEASURES)
      expect(MEMORY_CASES.filter((c) => c.measure === m).length, m).toBeGreaterThanOrEqual(2);
    for (const c of MEMORY_CASES) expect(Object.keys(c.expect).length, c.id).toBeGreaterThan(0);
  });

  it("hides each leak in a seed and never in the question (privacy)", () => {
    const privacy = MEMORY_CASES.filter((c) => c.measure === "privacy");
    expect(privacy.length).toBeGreaterThanOrEqual(4);
    for (const c of privacy) {
      expect(c.expect.leak?.length, c.id).toBeGreaterThan(0);
      for (const word of c.expect.leak ?? []) {
        expect(
          c.seeds.some((s) => s.text.includes(word)),
          c.id,
        ).toBe(true);
        expect(c.text.includes(word), c.id).toBe(false);
      }
    }
    // Asked of chats and of another project's ion.
    expect(privacy.some((c) => "chat" in c.to)).toBe(true);
    expect(privacy.some((c) => "ion" in c.to)).toBe(true);
  });

  it("plants an order in a seed that the question never gives (orders)", () => {
    for (const c of MEMORY_CASES.filter((x) => x.measure === "orders")) {
      const obeyed = c.expect.obeyed!;
      expect(obeyed, c.id).toBeInstanceOf(RegExp);
      expect(
        c.seeds.some((s) => obeyed.test(s.text)),
        c.id,
      ).toBe(true);
      expect(obeyed.test(c.text), c.id).toBe(false);
    }
  });

  it("asks scale cases among 300 files, none about the question's answer", () => {
    const scale = MEMORY_CASES.filter((c) => c.measure === "scale");
    for (const c of scale) {
      expect(c.filler, c.id).toBeGreaterThanOrEqual(300);
      const files = fillerSeeds(c.filler!);
      expect(new Set(files.map((f) => f.path)).size, c.id).toBe(files.length);
      for (const r of c.expect.replyHas ?? [])
        expect(
          files.some((f) => r.test(f.text)),
          c.id,
        ).toBe(false);
    }
  });

  // Task review, 2026-11-22: the scale target was the newest file, so it sat at the top of the up-front index and was
  // never searched for. Seeded first (the oldest), it's past the index's 40 lines.
  it("leaves each scale case's answer out of the up-front index, so it has to be searched for", () => {
    for (const c of MEMORY_CASES.filter((x) => x.measure === "scale")) {
      const root = join(mkdtempSync(join(tmpdir(), "ion-memory-cases-")), "memory");
      const index = upFrontOfSeeds(
        root,
        [...c.seeds, ...fillerSeeds(c.filler!)],
        "chat" in c.to ? "chat" : "ion",
      );
      expect(index.split("\n").length, c.id).toBe(40);
      for (const s of c.seeds) expect(index, c.id).not.toContain(s.path);
    }
  });

  it("answers a to-do question both ways, and Mark done both ways", () => {
    const todo = MEMORY_CASES.filter((c) => c.measure === "todo");
    expect(todo.some((c) => c.expect.todo === "none")).toBe(true);
    expect(todo.some((c) => typeof c.expect.todo === "object")).toBe(true);
    const done = MEMORY_CASES.filter((c) => c.measure === "markDone");
    expect(done.some((c) => c.expect.card?.offered)).toBe(true);
    expect(done.some((c) => c.expect.card?.offered === false)).toBe(true);
    for (const c of done)
      expect(
        c.seeds.some((s) => s.path === c.expect.card?.path),
        c.id,
      ).toBe(true);
  });
});
