import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { UserError } from "../api/errors.js";
import { git, type ReadAt } from "./git.js";

export const NOT_OURS = "The chat's worktree isn't as ion made it";

/**
 * The git folder ion keeps for this worktree, checked before ion reads it (automated scan, 2026-11-28: a chat's agent
 * can rewrite its worktree's .git to name a git folder it made, with filters and fsmonitor set there): the .git is a
 * plain file naming a folder in the project's own `worktrees` folder whose `gitdir` names this worktree back, whose
 * `commondir` is the project's own git folder, and with no `config.worktree`. Anything else is refused, in plain
 * words. This trusts the project's own .git, which a chat's agent can write too: the read-only sandbox ion's reads run
 * in, not this check, is what holds.
 */
export async function readAt(repo: string, worktree: string): Promise<ReadAt> {
  const common = await git(["rev-parse", "--git-common-dir"], repo);
  if (common.code !== 0) throw new UserError(NOT_OURS);
  try {
    const dotGit = join(worktree, ".git");
    if (!lstatSync(dotGit).isFile()) throw new UserError(NOT_OURS);
    const named = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
    if (!named) throw new UserError(NOT_OURS);
    const gitDir = realpathSync.native(resolve(worktree, named));
    const commonDir = realpathSync.native(resolve(repo, common.stdout.trim()));
    // Relative to the git folder when git wrote it relative (2.48+, worktree.useRelativePaths; re-review N4).
    const back = readFileSync(join(gitDir, "gitdir"), "utf8").trim();
    const workTree = realpathSync.native(worktree);
    if (
      dirname(gitDir) !== join(commonDir, "worktrees") ||
      realpathSync.native(dirname(resolve(gitDir, back))) !== workTree
    )
      throw new UserError(NOT_OURS);
    // Its common folder is the project's own, and it brings no config of its own (automated scan, 2026-11-28).
    const namedCommon = readFileSync(join(gitDir, "commondir"), "utf8").trim();
    if (
      realpathSync.native(resolve(gitDir, namedCommon)) !== commonDir ||
      existsSync(join(gitDir, "config.worktree"))
    )
      throw new UserError(NOT_OURS);
    const at = { gitDir, commonDir, workTree, quiet: [] };
    return { ...at, quiet: await quieted(at) };
  } catch {
    throw new UserError(NOT_OURS);
  }
}

/** The filter properties git runs or needs. */
const FILTER_KEYS = ["clean", "smudge", "process"];

/**
 * Every filter the repo's config names, turned off for ion's reads (security re-review, 2026-11-28, N3: one named in
 * the project's info/attributes ran in ion's diff): git skips a filter whose command is empty. A name `-c` couldn't
 * carry whole is refused.
 */
async function quieted(at: ReadAt): Promise<string[]> {
  const r = await git(["config", "--null", "--name-only", "--get-regexp", "^filter\\."], at.workTree, {
    read: at,
    plumbing: true,
  });
  if (r.code !== 0 && r.code !== 1) throw new UserError(NOT_OURS);
  const names = new Set(
    r.stdout
      .split("\0")
      .filter(Boolean)
      .map((k) => k.slice("filter.".length, k.lastIndexOf("."))),
  );
  if ([...names].some((n) => !n || /[=\n\0]/.test(n))) throw new UserError(NOT_OURS);
  return [...names].flatMap((n) => [
    ...FILTER_KEYS.flatMap((k) => ["-c", `filter.${n}.${k}=`]),
    ...["-c", `filter.${n}.required=false`],
  ]);
}
