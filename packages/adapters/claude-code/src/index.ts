import type { HarnessAdapter } from "@ion/adapter-kit";
import { CAPABILITIES, parseAuthStatus } from "./capabilities.js";
import { getSessionMessages, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { parseVersion, ResumeFailed, whichOnPath } from "@ion/adapter-kit";
import { type Exec, execNoShell, loginOnlyEnv, runLogin } from "./cli.js";
import { type QueryFn, startSession } from "./session.js";

export type { Exec } from "./cli.js";

export type ClaudeCodeDeps = {
  exec?: Exec;
  which?: (bin: string) => string | null;
  /** The SDK's query(); tests pass a scripted stand-in. */
  query?: QueryFn;
  /** Whether Claude Code still has this session for this folder (to continue it). */
  sessionExists?: (sessionId: string, dir: string) => Promise<boolean>;
};

/** Claude Code keeps sessions as transcripts per folder; a gone one has no messages. */
const sdkSessionExists = async (sessionId: string, dir: string) =>
  (await getSessionMessages(sessionId, { dir, limit: 1 }).catch(() => [])).length > 0;

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
      const version = parseVersion(stdout);
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
    async start(opts) {
      const path = binary();
      if (!path) throw new Error("Claude Code isn't installed");
      const auth = await this.auth.status();
      if (!auth.signedIn) throw new Error("Claude Code isn't signed in. Run: claude auth login");
      if (opts.resume && !(await (deps.sessionExists ?? sdkSessionExists)(opts.resume, opts.cwd)))
        throw new ResumeFailed("Claude Code no longer has this chat's session");
      return startSession(opts, {
        query: deps.query ?? (sdkQuery as unknown as QueryFn),
        binaryPath: path,
        authMethod: auth.method,
      });
    },
  };
}
