import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { chatDiff, createWorktree } from "./index.js";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let repo: string;
let dataDir: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "ion-diff-repo-"));
  dataDir = mkdtempSync(join(tmpdir(), "ion-diff-data-"));
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "test@example.com");
  sh(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "# repo\nold line\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", "init");
});

describe("chatDiff", () => {
  it("shows what the chat changed: commits on its branch and uncommitted work, new files included", async () => {
    const wt = await createWorktree(repo, dataDir, "chat_d", "Diff");
    writeFileSync(join(wt.path, "README.md"), "# repo\nnew line\n");
    sh(wt.path, "commit", "-q", "-am", "edit");
    writeFileSync(join(wt.path, "notes.md"), "one\ntwo\n");
    // The project moving on doesn't show up as the chat's change.
    writeFileSync(join(repo, "other.md"), "x\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-q", "-m", "elsewhere");
    const files = await chatDiff(repo, wt.path);
    expect(files.map((f) => [f.path, f.added, f.removed])).toEqual([
      ["README.md", 1, 1],
      ["notes.md", 2, 0],
    ]);
    expect(files[0]!.patch).toContain("-old line\n+new line");
    expect(files[1]!.patch).toContain("+one\n+two");
  });

  it("cuts a huge patch and says so", async () => {
    const wt = await createWorktree(repo, dataDir, "chat_big", "Big");
    writeFileSync(join(wt.path, "big.txt"), "x".repeat(300_000));
    const [f] = await chatDiff(repo, wt.path);
    expect(f!.truncated).toBe(true);
    expect(f!.patch.length).toBeLessThanOrEqual(200 * 1024);
  });

  it("is empty when the worktree is gone", async () => {
    expect(await chatDiff(repo, join(dataDir, "worktrees", "nope"))).toEqual([]);
  });
});
