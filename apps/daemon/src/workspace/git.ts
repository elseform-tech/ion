import { execFile } from "node:child_process";
import { whichOnPath } from "@ion/adapter-kit";

export type GitResult = { code: number; stdout: string; stderr: string };

let gitPath: string | null = null;
const resolveGit = (): string => {
  gitPath ??= whichOnPath("git");
  if (!gitPath) throw new Error("git isn't installed");
  return gitPath;
};

/** Runs git (found once on PATH) without a shell and without ever prompting. */
export function git(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      resolveGit(),
      args,
      { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" }, timeout: 60_000 },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) code = typeof err.code === "number" ? err.code : 1;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}
