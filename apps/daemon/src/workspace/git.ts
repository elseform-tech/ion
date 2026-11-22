import { execFile } from "node:child_process";
import { type RunSandbox, sandboxed, whichOnPath } from "@ion/adapter-kit";

export type GitResult = { code: number; stdout: string; stderr: string };

let gitPath: string | null = null;
const resolveGit = (): string => {
  gitPath ??= whichOnPath("git");
  if (!gitPath) throw new Error("git isn't installed");
  return gitPath;
};

let box: RunSandbox | undefined;

/**
 * The sandbox ion's own git runs in (security review, 2026-11-21: a filter a run planted in the project's
 * .git/config ran in the daemon's `git diff`, outside the sandbox, and read daemon.json): ion's folders denied, its
 * worktrees writable. Set once at the daemon's start; none where the computer has no sandbox.
 */
export function sandboxGit(sb: RunSandbox | undefined): void {
  box = sb;
}

/**
 * Only what git needs; nothing like GIT_DIR, GIT_SSH_COMMAND or tokens leaks in from the daemon. No global or system
 * config either (a run can write ~/.gitconfig), except for a repo ion has just made for you (`yours`: its identity).
 */
function gitEnv(yours = false): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR"];
  const env: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: "true",
    ...(yours ? {} : { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }),
  };
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

/**
 * Runs git without a shell, without prompting, with a minimal environment and with the repo's hooks turned off:
 * a cloned repo's hooks must never run code when ion makes or removes a worktree.
 */
export function git(args: string[], cwd: string, o: { yours?: boolean } = {}): Promise<GitResult> {
  const run = sandboxed(box, resolveGit(), [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    ...args,
  ]);
  return new Promise((resolve) => {
    execFile(
      run.command,
      run.args,
      // Diffs can be large: Node's 1 MB default would cut them off silently.
      { cwd, env: gitEnv(o.yours), timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // git's own exit code; -1 when git didn't finish (couldn't start, timed out, output too large).
        let code = 0;
        if (err) code = typeof err.code === "number" ? err.code : -1;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}
