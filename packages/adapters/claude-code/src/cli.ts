import { execFile } from "node:child_process";
import { agentEnv } from "@ion/adapter-kit";

export type Exec = (
  file: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv },
) => Promise<{ code: number; stdout: string }>;

/** Runs a program directly (never through a shell, so shell functions and aliases don't apply). */
export const execNoShell: Exec = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { env: agentEnv(opts?.env), timeout: 15_000 }, (err, stdout) => {
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
  // Your keys (mcp.json's) are never inherited either.
  const out = agentEnv(env);
  for (const k of API_KEY_VARS) delete out[k];
  // A run's MCP key is passed in ION_MCP_H<i> (see session.ts): never inherit another run's.
  for (const k of Object.keys(out)) if (k.startsWith("ION_MCP_")) delete out[k];
  return out;
}
