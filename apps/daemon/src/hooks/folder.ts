import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { realForms, type RunSandbox } from "@ion/adapter-kit";

/** `p` inside `dir` (or `dir` itself). */
const within = (p: string, dir: string) => {
  const r = relative(dir, p);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

/**
 * This chat's own worktree, as ion made it, by its real path, for its hooks' sandbox to make writable (security
 * review, 2026-11-28: a chat's agent can swap its worktree folder for a link to your home, or to another chat's
 * worktree): a real folder, not a link, at `<data>/worktrees/<chatId>` once every link above it is followed, holding
 * none of ion's denied folders; null otherwise. The real path is what's used after (re-review, N1: the path given
 * was resolved again later, so a root swapped meanwhile got its link's target). With no sandbox there's nothing to
 * grant: any folder that's there, as given.
 */
export function ownWorktree(cwd: string, chatId: string | null, sb: RunSandbox | undefined): string | null {
  if (!sb) return existsSync(cwd) ? cwd : null;
  try {
    const st = lstatSync(cwd);
    if (!chatId || st.isSymbolicLink() || !st.isDirectory()) return null;
    const real = realpathSync.native(cwd);
    if (real !== join(realpathSync.native(sb.dataDir), "worktrees", chatId)) return null;
    return sb.paths.deny.flatMap(realForms).some((d) => within(d, real)) ? null : real;
  } catch {
    return null;
  }
}
