import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.js";

export type Worktree = { path: string; branch: string };

const slug = (title: string) =>
  title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join("-")
    .slice(0, 40) || "chat";

/** The chat's branch name: stable for the chat, so a lost folder can be recreated on the same branch. */
const branchFor = (chatId: string, title: string) =>
  `ion/${slug(title)}-${createHash("sha1").update(chatId).digest("hex").slice(0, 6)}`;

async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo)).code === 0;
}

/**
 * The chat's own worktree at `<dataDir>/worktrees/<chatId>`, on branch `ion/<slug>-<hex>` from the project's HEAD.
 * Idempotent; a folder deleted by hand is recreated on the same branch.
 */
export async function createWorktree(
  repo: string,
  dataDir: string,
  chatId: string,
  title: string,
): Promise<Worktree> {
  if ((await git(["rev-parse", "--git-dir"], repo)).code !== 0)
    throw new Error(`Not a git repository: ${repo}`);
  const path = join(dataDir, "worktrees", chatId);
  const branch = branchFor(chatId, title);
  if (existsSync(join(path, ".git"))) {
    // Report what's really checked out there (the title may have changed since).
    const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], path);
    return { path, branch: head.code === 0 ? head.stdout.trim() : branch };
  }
  mkdirSync(join(dataDir, "worktrees"), { recursive: true, mode: 0o700 });
  await git(["worktree", "prune"], repo); // forget registrations whose folder is gone
  const args = (await branchExists(repo, branch))
    ? ["worktree", "add", path, branch]
    : ["worktree", "add", "-b", branch, path, "HEAD"];
  const r = await git(args, repo);
  if (r.code !== 0) throw new Error(`Couldn't create the chat's worktree: ${r.stderr.trim().split("\n")[0]}`);
  return { path, branch };
}

/** Removes the worktree folder; the branch (and its commits) stay. Already gone is fine; failing is an error. */
export async function removeWorktree(repo: string, path: string): Promise<void> {
  if (!existsSync(path)) {
    await git(["worktree", "prune"], repo);
    return;
  }
  const r = await git(["worktree", "remove", "--force", path], repo);
  await git(["worktree", "prune"], repo);
  if (r.code !== 0 || existsSync(path))
    throw new Error(`Couldn't remove the chat's worktree: ${r.stderr.trim().split("\n")[0] || path}`);
}
