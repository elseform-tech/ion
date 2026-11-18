import { existsSync } from "node:fs";
import type { FileDiff } from "@ion/schema";
import { git } from "./git.js";

const PATCH_MAX = 200 * 1024;
const UNTRACKED_MAX = 200;
// Plain diffs only: no external diff programs, no textconv, no colour, no rename guessing.
const DIFF = ["-c", "diff.external=", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"];

const num = (s: string | undefined) => (s && /^\d+$/.test(s) ? Number(s) : 0);

/** `--numstat -z` output: added, removed and path per file (binary files count as 0). */
function numstat(out: string): Map<string, { added: number; removed: number }> {
  const m = new Map<string, { added: number; removed: number }>();
  for (const rec of out.split("\0")) {
    const [a, r, ...rest] = rec.split("\t");
    const path = rest.join("\t");
    if (path) m.set(path, { added: num(a), removed: num(r) });
  }
  return m;
}

/** A whole diff split per file, keyed by the file's path (from its "diff --git a/… b/…" line). */
function patches(out: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of out.split(/^(?=diff --git )/m)) {
    const path = /^diff --git a\/.* b\/(.*)$/m.exec(part)?.[1];
    if (path) m.set(path, part);
  }
  return m;
}

const cut = (f: Omit<FileDiff, "truncated">): FileDiff =>
  f.patch.length > PATCH_MAX ? { ...f, patch: f.patch.slice(0, PATCH_MAX), truncated: true } : f;

/** Files the chat added and hasn't committed (git diff alone doesn't see them). */
async function untracked(worktree: string): Promise<FileDiff[]> {
  const list = (await git(["ls-files", "--others", "--exclude-standard", "-z"], worktree)).stdout;
  const files = list.split("\0").filter(Boolean).slice(0, UNTRACKED_MAX);
  const out: FileDiff[] = [];
  for (const path of files) {
    const patch = (await git([...DIFF, "--no-index", "--", "/dev/null", path], worktree)).stdout;
    // A new file: every line is added (binary files have none).
    const added = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
    out.push(cut({ path, added, removed: 0, patch }));
  }
  return out;
}

/**
 * What a chat changed in its worktree: everything since its branch left the project (its commits and uncommitted
 * work, new files included), not what the project did meanwhile. Empty when the worktree is gone.
 */
export async function chatDiff(repo: string, worktree: string): Promise<FileDiff[]> {
  if (!existsSync(worktree)) return [];
  const head = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
  const base = (await git(["merge-base", "HEAD", head], worktree)).stdout.trim() || "HEAD";
  const counts = numstat((await git([...DIFF, "--numstat", "-z", base], worktree)).stdout);
  const byPath = patches((await git([...DIFF, base], worktree)).stdout);
  const tracked = [...counts].map(([path, c]) => cut({ path, ...c, patch: byPath.get(path) ?? "" }));
  return [...tracked, ...(await untracked(worktree))].sort((a, b) => (a.path < b.path ? -1 : 1));
}
