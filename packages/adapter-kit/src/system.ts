import { execFile } from "node:child_process";
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

export const parseVersion = (text: string): string | null =>
  /\b\d{1,4}\.\d{1,4}\.\d{1,6}\b/.exec(text)?.[0] ?? null;

/** Runs `path args` without a shell and returns the version it prints. */
export function readVersion(path: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) =>
    execFile(path, args, { timeout: 10_000, env }, (_e, out) => resolve(parseVersion(String(out)))),
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
