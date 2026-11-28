import { execFile } from "node:child_process";
import { agentEnv } from "./run-env.js";
import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";

/** The first executable named `bin` on PATH, or null. Shell functions and aliases never count. */
export function whichOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, bin), constants.X_OK);
      return join(dir, bin);
    } catch {
      // not here
    }
  }
  return null;
}

/**
 * An agent's binary (claude, codex, grok, opencode): on PATH, or under tests and the tour only in ION_AGENTS_PATH, a
 * folder of stand-ins or none, so their checks never start your real agents (2026-11-28: `pnpm check` ran `claude auth
 * status`, `opencode acp` and `grok agent stdio`). Live evals (ION_LIVE*) leave it unset.
 */
export function whichAgent(bin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const own = (env.VITEST || env.ION_TOUR === "1") && env.ION_AGENTS_PATH !== undefined;
  return whichOnPath(bin, own ? { PATH: env.ION_AGENTS_PATH } : env);
}

export const parseVersion = (text: string): string | null =>
  /\b\d{1,4}\.\d{1,4}\.\d{1,6}\b/.exec(text)?.[0] ?? null;

/** Runs `path args` without a shell and returns the version it prints. */
export function readVersion(path: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) =>
    execFile(path, args, { timeout: 10_000, env: agentEnv(env) }, (_e, out) =>
      resolve(parseVersion(String(out))),
    ),
  );
}

/** The project folder and its real path when different (symlinks, macOS /var → /private/var). */
export function projectRoots(cwd: string): string[] {
  try {
    const real = realpathSync(cwd);
    return real === cwd ? [cwd] : [cwd, real];
  } catch {
    return [cwd];
  }
}
