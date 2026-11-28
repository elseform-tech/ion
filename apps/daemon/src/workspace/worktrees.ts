import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { UserError } from "../api/errors.js";
import { git } from "./git.js";
import { NOT_OURS, readAt } from "./trusted.js";

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
  const path = await rootFor(dataDir, chatId);
  const branch = branchFor(chatId, title);
  const st = statOf(path);
  if (st && !ownRoot(path, st)) throw new UserError(NOT_OURS);
  if (st && existsSync(join(path, ".git"))) {
    // Checked as ion made it, and read through its checked git folder (automated scan, 2026-11-28): what's really
    // checked out there (the title may have changed since).
    const read = await readAt(repo, path);
    const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], path, { read, plumbing: true });
    unchanged(path, st);
    return { path, branch: head.code === 0 ? head.stdout.trim() : branch };
  }
  // Forget registrations whose folder is gone: it sees ion's worktrees folder, or it would forget them all.
  await git(["worktree", "prune"], repo, { sees: dirname(path) });
  await makeWorktree(repo, path, branch);
  return { path, branch };
}

/**
 * Makes the worktree without its files, then checks them out with every filter off and no system attributes
 * (security re-review 2, 2026-11-28: a smudge filter planted in the project's git ran here), writing only this
 * worktree; checked again once git made it, so a root swapped meanwhile is never handed to the run.
 */
async function makeWorktree(repo: string, path: string, branch: string): Promise<void> {
  const args = (await branchExists(repo, branch))
    ? ["worktree", "add", "--no-checkout", path, branch]
    : ["worktree", "add", "--no-checkout", "-b", branch, path, "HEAD"];
  const r = await git(args, repo, { writes: path });
  if (r.code !== 0) throw new Error(`Couldn't create the chat's worktree: ${firstLine(r.stderr)}`);
  const made = statOf(path);
  if (!made || !ownRoot(path, made)) throw new UserError(NOT_OURS);
  const read = await readAt(repo, path);
  const env = {
    ...{ GIT_DIR: read.gitDir, GIT_COMMON_DIR: read.commonDir, GIT_WORK_TREE: read.workTree },
    GIT_ATTR_NOSYSTEM: "1",
  };
  // Never into submodules, whose own git config and filters ion hasn't checked (re-review 3, 2026-11-28).
  const out = await git([...read.quiet, ...NO_SUBMODULES, "reset", "--hard", "-q"], path, {
    writes: path,
    env,
  });
  if (out.code !== 0) throw new Error(`Couldn't create the chat's worktree: ${firstLine(out.stderr)}`);
  unchanged(path, made);
}

/**
 * The chat's worktree root, by its real path, in ion's own worktrees folder (a real folder, never a link; security
 * re-review and automated scan, 2026-11-28: a chat's agent swapped its worktree for a link to another chat's).
 */
async function rootFor(dataDir: string, chatId: string): Promise<string> {
  const folder = join(dataDir, "worktrees");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const st = lstatSync(folder);
  if (
    st.isSymbolicLink() ||
    !st.isDirectory() ||
    realpathSync.native(folder) !== join(realpathSync.native(dataDir), "worktrees")
  )
    throw new UserError(NOT_OURS);
  return join(realpathSync.native(folder), chatId);
}

/**
 * The chat's worktree, checked again where it's handed to an agent (security re-review 2, 2026-11-28: a root swapped
 * for a link after it was made reached Codex's own sandbox): a real folder at `<data>/worktrees/<chatId>`, at its own
 * real path, given back. Refused otherwise.
 */
export function stillOurs(dataDir: string, chatId: string, path: string): string {
  const st = statOf(path);
  const want = join(realpathSync.native(join(dataDir, "worktrees")), chatId);
  if (!st || path !== want || !ownRoot(path, st)) throw new UserError(NOT_OURS);
  return path;
}

/** A real folder at its own real path: never a link. */
const ownRoot = (path: string, st: Stats) =>
  !st.isSymbolicLink() && st.isDirectory() && realpathSync.native(path) === path;

/** The same folder as when it was checked (same entry, still its own real path); refused otherwise. */
function unchanged(path: string, was: Stats): void {
  const now = statOf(path);
  if (!now || now.ino !== was.ino || now.dev !== was.dev || !ownRoot(path, now))
    throw new UserError(NOT_OURS);
}

/** git that writes a worktree never recurses into its submodules. */
const NO_SUBMODULES = ["-c", "submodule.recurse=false"];

const firstLine = (s: string) => s.trim().split("\n")[0];

/** The path's own entry (a link as a link), or null when nothing is there. */
function statOf(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** Removes the worktree folder; the branch (and its commits) stay. Already gone is fine; failing is an error. */
export async function removeWorktree(repo: string, path: string): Promise<void> {
  const sees = dirname(path);
  if (!existsSync(path)) {
    await git(["worktree", "prune"], repo, { sees });
    return;
  }
  const r = await git([...NO_SUBMODULES, "worktree", "remove", "--force", path], repo, {
    writes: path,
    sees,
  });
  await git(["worktree", "prune"], repo, { sees });
  if (r.code !== 0 || existsSync(path))
    throw new Error(`Couldn't remove the chat's worktree: ${r.stderr.trim().split("\n")[0] || path}`);
}
