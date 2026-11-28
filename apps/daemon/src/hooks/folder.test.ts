import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ownWorktree } from "./folder.js";

// Security re-review, 2026-11-28 (N1): the worktree was checked, then its unchecked path went into the hook's
// sandbox, where it was resolved again, so a root swapped for a link between the two got the link's target. The
// checked real path is what the sandbox gets.
describe("a hook's worktree, checked", () => {
  const setup = () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ion-own-")));
    mkdirSync(join(root, "home", "data", "worktrees", "c1"), { recursive: true });
    const via = join(root, "via");
    symlinkSync(join(root, "home"), via);
    const sb = {
      kind: "seatbelt" as const,
      dataDir: join(via, "data"),
      paths: { deny: [], read: [], write: [], noWrite: [] },
    };
    return { root, via, sb };
  };

  it("is its real path, never the path it was given", () => {
    const { root, via, sb } = setup();
    expect(ownWorktree(join(via, "data", "worktrees", "c1"), "c1", sb)).toBe(
      join(root, "home", "data", "worktrees", "c1"),
    );
  });

  it("is none for a root that is a link, or another chat's", () => {
    const { root, sb } = setup();
    const wts = join(root, "home", "data", "worktrees");
    symlinkSync(join(wts, "c1"), join(wts, "c2"));
    expect(ownWorktree(join(wts, "c2"), "c2", sb)).toBeNull();
    expect(ownWorktree(join(wts, "c1"), "c2", sb)).toBeNull();
  });
});
