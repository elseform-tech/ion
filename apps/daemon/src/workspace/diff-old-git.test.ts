import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";

// Automated scan, 2026-11-28: ion's diff kept a chat's attributes out with GIT_ATTR_SOURCE, which a git older than
// 2.40 ignores without a word. On an old git ion says so instead of reading the chat's changes unprotected.
describe("an old git", () => {
  it("doesn't silently skip the protection", async () => {
    const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const bin = mkdtempSync(join(tmpdir(), "ion-old-git-"));
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nfor a in "$@"; do [ "$a" = "--version" ] && { echo "git version 2.39.5"; exit 0; }; done\nexec ${real} "$@"\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
    const { chatDiff, createWorktree } = await import("./index.js");
    const repo = mkdtempSync(join(tmpdir(), "ion-old-repo-"));
    const sh = (...args: string[]) => execFileSync(real, args, { cwd: repo });
    sh("init", "-q", "-b", "main");
    sh("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "i");
    const wt = await createWorktree(repo, mkdtempSync(join(tmpdir(), "ion-old-data-")), "chat_old", "Old");
    await expect(chatDiff(repo, wt.path)).rejects.toThrow(
      "ion needs git 2.40 or later to show a chat's changes",
    );
  });
});
