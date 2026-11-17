import { execFile, spawn } from "node:child_process";

export type Exec = (
  file: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv },
) => Promise<{ code: number; stdout: string }>;

/** Runs a program directly (never through a shell, so shell functions and aliases don't apply). */
export const execNoShell: Exec = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { env: opts?.env, timeout: 15_000 }, (err, stdout) => {
      let code = 0;
      if (err) code = typeof err.code === "number" ? err.code : 1;
      resolve({ code, stdout: String(stdout) });
    });
  });

/** Keys that would make Claude Code bill an API key instead of the user's Claude login. */
const API_KEY_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  // Cloud providers take priority over the Claude login too.
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

/** The current environment without API keys, so Claude Code always uses its own login. */
export function loginOnlyEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of API_KEY_VARS) delete out[k];
  return out;
}

/** Runs `claude auth login` in the user's terminal. */
export function runLogin(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, ["auth", "login"], { stdio: "inherit", env: loginOnlyEnv() });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("Sign-in didn't finish"))));
    child.on("error", reject);
  });
}
