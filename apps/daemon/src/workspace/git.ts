import { execFile } from "node:child_process";
import { whichOnPath } from "@ion/adapter-kit";

export type GitResult = { code: number; stdout: string; stderr: string };

let gitPath: string | null = null;
const resolveGit = (): string => {
  gitPath ??= whichOnPath("git");
  if (!gitPath) throw new Error("git isn't installed");
  return gitPath;
};

/** Only what git needs; nothing like GIT_DIR, GIT_SSH_COMMAND or tokens leaks in from the daemon. */
function gitEnv(): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR"];
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" };
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

/**
 * Runs git without a shell, without prompting, with a minimal environment and with the repo's hooks turned off:
 * a cloned repo's hooks must never run code when ion makes or removes a worktree.
 */
export function git(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      resolveGit(),
      ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
      { cwd, env: gitEnv(), timeout: 60_000 },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) code = typeof err.code === "number" ? err.code : 1;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}
