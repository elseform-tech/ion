import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createWorktree, removeWorktree } from "./index.js";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let repo: string;
let dataDir: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "ion-wt-repo-"));
  dataDir = mkdtempSync(join(tmpdir(), "ion-wt-data-"));
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "test@example.com");
  sh(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "# repo\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", "init");
});

describe("worktrees", () => {
  it("creates one worktree per chat on its own ion/ branch", async () => {
    const wt = await createWorktree(repo, dataDir, "chat_abc", "Fix checkout rounding!");
    expect(wt.path).toBe(join(dataDir, "worktrees", "chat_abc"));
    expect(wt.branch).toMatch(/^ion\/fix-checkout-rounding-[0-9a-f]{6}$/);
    expect(existsSync(join(wt.path, "README.md"))).toBe(true);
    expect(sh(wt.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(wt.branch);
  });

  it("returns the same worktree for the same chat", async () => {
    const a = await createWorktree(repo, dataDir, "chat_abc", "One");
    const b = await createWorktree(repo, dataDir, "chat_abc", "One");
    expect(b).toEqual(a);
  });

  it("recreates a worktree folder deleted by hand, on the same branch", async () => {
    const wt = await createWorktree(repo, dataDir, "chat_abc", "One");
    rmSync(wt.path, { recursive: true, force: true });
    const again = await createWorktree(repo, dataDir, "chat_abc", "One");
    expect(again).toEqual(wt);
    expect(existsSync(join(again.path, "README.md"))).toBe(true);
  });

  it("removes the worktree but keeps its branch", async () => {
    const wt = await createWorktree(repo, dataDir, "chat_abc", "One");
    await removeWorktree(repo, wt.path);
    expect(existsSync(wt.path)).toBe(false);
    expect(sh(repo, "branch", "--list", wt.branch)).toContain(wt.branch);
  });

  it("refuses a folder that isn't a git repository", async () => {
    const plain = mkdtempSync(join(tmpdir(), "ion-wt-plain-"));
    await expect(createWorktree(plain, dataDir, "chat_x", "x")).rejects.toThrow("Not a git repository");
  });

  // Regression (security review): a repo's git hooks must never run when ion creates a worktree.
  it("never runs the repo's git hooks", async () => {
    const marker = join(dataDir, "hook-ran");
    writeFileSync(join(repo, ".git", "hooks", "post-checkout"), `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(join(repo, ".git", "hooks", "post-checkout"), 0o755);
    await createWorktree(repo, dataDir, "chat_hook", "Hooks");
    expect(existsSync(marker)).toBe(false);
  });

  // Regression (security review): repo config like core.fsmonitor must not run code in ion's git calls.
  it("never runs core.fsmonitor from the repo's config", async () => {
    const marker = join(dataDir, "fsmonitor-ran");
    const script = join(dataDir, "fsmon.sh");
    writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(script, 0o755);
    const wt = await createWorktree(repo, dataDir, "chat_fs", "Fs");
    execFileSync("git", ["config", "core.fsmonitor", script], { cwd: repo });
    await createWorktree(repo, dataDir, "chat_fs", "Fs");
    await removeWorktree(repo, wt.path);
    expect(existsSync(marker)).toBe(false);
  });

  it("reports the branch actually checked out, even if the title changed", async () => {
    const first = await createWorktree(repo, dataDir, "chat_abc", "One");
    const again = await createWorktree(repo, dataDir, "chat_abc", "A different title");
    expect(again.branch).toBe(first.branch);
  });

  it("says so when removing a worktree fails, and is fine with one that's already gone", async () => {
    const wt = await createWorktree(repo, dataDir, "chat_abc", "One");
    await removeWorktree(repo, wt.path);
    await expect(removeWorktree(repo, wt.path)).resolves.toBeUndefined();
    const plain = mkdtempSync(join(tmpdir(), "ion-wt-notwt-"));
    writeFileSync(join(plain, "keep.txt"), "x");
    await expect(removeWorktree(repo, plain)).rejects.toThrow("Couldn't remove the chat's worktree");
  });
});
