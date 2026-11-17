import type { HarnessAdapter } from "@ion/adapter-kit";
import { CAPABILITIES, parseAuthStatus } from "./capabilities.js";
import { type Exec, execNoShell, loginOnlyEnv, runLogin, whichOnPath } from "./cli.js";

export type { Exec } from "./cli.js";

export type ClaudeCodeDeps = {
  exec?: Exec;
  which?: (bin: string) => string | null;
};

export function createClaudeCodeAdapter(deps: ClaudeCodeDeps = {}): HarnessAdapter {
  const exec = deps.exec ?? execNoShell;
  const which = deps.which ?? ((b: string) => whichOnPath(b));
  const binary = () => which("claude");
  return {
    id: "claude-code",
    async detect() {
      const path = binary();
      if (!path) return { installed: false };
      const { stdout } = await exec(path, ["--version"], { env: loginOnlyEnv() });
      const version = /\b\d{1,4}\.\d{1,4}\.\d{1,6}\b/.exec(stdout)?.[0];
      return { installed: true, ...(version ? { version } : {}), path };
    },
    auth: {
      async status() {
        const path = binary();
        if (!path) return { signedIn: false, method: "Not installed" };
        const r = await exec(path, ["auth", "status", "--json"], { env: loginOnlyEnv() });
        return parseAuthStatus(r.code, r.stdout);
      },
      async login() {
        const path = binary();
        if (!path) throw new Error("Claude Code isn't installed");
        await runLogin(path);
      },
    },
    capabilities: async () => CAPABILITIES,
    start: async () => {
      throw new Error("Not implemented yet");
    },
  };
}
