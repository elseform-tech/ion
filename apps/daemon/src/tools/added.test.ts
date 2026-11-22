import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeen } from "./added.js";

// Final review, 2026-11-22 (automated review of M3): "nothing seen yet" decides whether agents' own servers count as
// already there, so an unreadable store must never read as an empty one.
describe("createSeen", () => {
  const file = () => join(mkdtempSync(join(tmpdir(), "ion-seen-")), "seen.json");

  it("tells a store never written (empty) from one that holds keys or can't be read", () => {
    const f = file();
    expect(createSeen(f).state()).toBe("empty");
    createSeen(f).add(["a"]);
    expect(createSeen(f).state()).toBe("ok");
    writeFileSync(f, "{not json");
    expect(createSeen(f).state()).toBe("unreadable");
    expect(createSeen(f).has("a")).toBe(false);
  });
});
