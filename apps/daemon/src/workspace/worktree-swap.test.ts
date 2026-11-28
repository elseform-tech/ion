import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";

// Automated scan, 2026-11-28 (worktrees.ts): the worktree root was checked, then git ran, then the path was handed to
// the run; a root swapped for a link in between went to the run unchecked. It's checked again after git.
describe("a worktree root swapped while git makes it", () => {
  it("is refused", async () => {
    const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const bin = mkdtempSync(join(tmpdir(), "ion-swap-git-"));
    const other = mkdtempSync(join(tmpdir(), "ion-swap-other-"));
    // Makes the worktree, then swaps its folder for a link to another folder.
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\n${real} "$@"; code=$?\nfor a in "$@"; do last="$a"; done\ncase " $* " in *" worktree add "*) for a in "$@"; do case "$a" in */worktrees/*) rm -rf "$a"; ln -s "${other}" "$a";; esac; done;; esac\nexit $code\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
    const { createWorktree } = await import("./index.js");
    const repo = mkdtempSync(join(tmpdir(), "ion-swap-repo-"));
    const sh = (...args: string[]) => execFileSync(real, args, { cwd: repo });
    sh("init", "-q", "-b", "main");
    sh("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "i");
    const data = mkdtempSync(join(tmpdir(), "ion-swap-data-"));
    await expect(createWorktree(repo, data, "chat_swap", "Swap")).rejects.toThrow(
      "The chat's worktree isn't as ion made it",
    );
  });
});
