import { existsSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import type { FileDiff } from "@ion/schema";
import { UserError } from "../api/errors.js";
import { git } from "./git.js";

const PATCH_MAX = 200 * 1024;
const FILES_MAX = 200;
// Plain diffs only: paths taken literally (no pathspec magic), no external diff programs, no textconv, no colour,
// no rename guessing.
const DIFF = [
  "--literal-pathspecs",
  "-c",
  "diff.external=",
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--no-renames",
];

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

/** A patch kept to 200 KB; one git couldn't give in full (or at all) is marked cut, never shown as empty. */
function cut(f: Omit<FileDiff, "truncated">, ok: boolean): FileDiff {
  if (!ok) return { ...f, truncated: true };
  return f.patch.length > PATCH_MAX ? { ...f, patch: f.patch.slice(0, PATCH_MAX), truncated: true } : f;
}

/**
 * A new file the chat made, if it's a regular file really inside the worktree: never a symlink out of it, and
 * never a hard link (it could be the same file as one elsewhere on your machine).
 */
async function regularInside(root: string, worktree: string, path: string): Promise<boolean> {
  const full = join(worktree, path);
  try {
    const st = await lstat(full);
    return st.isFile() && st.nlink === 1 && (await realpath(full)).startsWith(root + sep);
  } catch {
    return false;
  }
}

/** Files the chat added and hasn't committed (git diff alone doesn't see them), and how many weren't shown. */
async function untracked(worktree: string): Promise<{ files: FileDiff[]; omitted: number }> {
  const list = (await git(["ls-files", "--others", "--exclude-standard", "-z"], worktree)).stdout;
  const all = list.split("\0").filter(Boolean);
  const root = await realpath(worktree);
  const files: FileDiff[] = [];
  let checked = 0;
  // Checked in order only until the cap is reached: a huge folder of new files costs at most that many checks.
  for (const path of all) {
    if (files.length >= FILES_MAX) break;
    checked++;
    if (!(await regularInside(root, worktree, path))) continue;
    const r = await git([...DIFF, "--no-index", "--", "/dev/null", path], worktree);
    // A new file: every line is added (binary files have none). Exit 1 just means "they differ".
    const added = r.stdout.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
    files.push(cut({ path, added, removed: 0, patch: r.stdout }, r.code === 0 || r.code === 1));
  }
  return { files, omitted: all.length - checked };
}
/** Where the chat's branch left the project; if git can't say, ion says so rather than show less. */
async function baseOf(repo: string, worktree: string): Promise<string> {
  const head = await git(["rev-parse", "HEAD"], repo);
  const base = head.code === 0 ? await git(["merge-base", "HEAD", head.stdout.trim()], worktree) : null;
  const sha = base?.code === 0 ? base.stdout.trim() : "";
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new UserError("Couldn't read the chat's changes");
  return sha;
}

/**
 * What a chat changed in its worktree: everything since its branch left the project (its commits and uncommitted
 * work, new files included), not what the project did meanwhile. Each file's patch is read on its own, by the
 * path git lists. Empty when the worktree is gone.
 */
export async function chatDiff(
  repo: string,
  worktree: string,
): Promise<{ files: FileDiff[]; omitted?: number }> {
  if (!existsSync(worktree)) return { files: [] };
  const base = await baseOf(repo, worktree);
  const counts = [...numstat((await git([...DIFF, "--numstat", "-z", base], worktree)).stdout)];
  const tracked: FileDiff[] = [];
  for (const [path, c] of counts.slice(0, FILES_MAX)) {
    const r = await git([...DIFF, base, "--", path], worktree);
    tracked.push(cut({ path, ...c, patch: r.stdout }, r.code === 0));
  }
  const fresh = await untracked(worktree);
  const omitted = Math.max(0, counts.length - FILES_MAX) + fresh.omitted;
  const files = [...tracked, ...fresh.files].sort((a, b) => (a.path < b.path ? -1 : 1));
  return omitted ? { files, omitted } : { files };
}
