import type { HarnessAdapter } from "@ion/adapter-kit";
import { CAPABILITIES, FALLBACK_MODELS, parseAuthStatus } from "./capabilities.js";
import { getSessionMessages, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { cachedCatalog, capabilitiesWith, parseVersion, ResumeFailed, whichOnPath } from "@ion/adapter-kit";
import { type Exec, execNoShell, loginOnlyEnv, runLogin } from "./cli.js";
import { claudeGateCall } from "./gate.js";
import { type QueryFn, startSession } from "./session.js";

export type { Exec } from "./cli.js";

export type ClaudeCodeDeps = {
  exec?: Exec;
  which?: (bin: string) => string | null;
  /** The SDK's query(); tests pass a scripted stand-in. */
  query?: QueryFn;
  /** Claude Code's own model list (`supportedModels()`); tests pass a stand-in. */
  listModels?: () => Promise<{ value: string; displayName: string }[]>;
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
    // ion's sandbox around the claude process (its own covers commands only, not its Read tool).
    sandbox: "ion",
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
    capabilities: capabilitiesWith(CAPABILITIES, claudeCatalog(deps, binary)),
    // The Agent SDK's mcpServers takes both.
    mcpTransports: { http: true },
    // No web on request (ion's dream): its web tools off with disallowedTools.
    noWeb: true,
    // Its models' standard context.
    contextTokens: 200_000,
    // Claude Code runs `/command` (its own and its plugins') at the start of a prompt.
    picks: "slash",
    // It reads a server's resources (@server:uri, and its resource tools).
    mcpResources: true,
    gateCall: claudeGateCall,
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

/** Claude Code's models, kept for 10 minutes; its aliases when it can't list them. */
function claudeCatalog(deps: ClaudeCodeDeps, binary: () => string | null) {
  return cachedCatalog(
    async (signal) => {
      const path = binary();
      if (!path && !deps.listModels) throw new Error("Claude Code isn't installed");
      const list = await (deps.listModels ?? (() => sdkModels(path ?? "", signal)))();
      // "default" isn't a model: it's what Claude Code picks when none is given.
      const models = list
        .filter((m) => m.value !== "default")
        .map((m) => ({ id: m.value, label: m.displayName }));
      return { models, defaultModel: null };
    },
    { fallback: { models: FALLBACK_MODELS, defaultModel: null } },
  );
}

/**
 * Claude Code's model list from an idle session: it starts, answers `supportedModels()` and is stopped before
 * any prompt is sent, so it costs nothing.
 */
async function sdkModels(
  binaryPath: string,
  signal: AbortSignal,
): Promise<{ value: string; displayName: string }[]> {
  const abort = new AbortController();
  signal.addEventListener("abort", () => abort.abort(), { once: true });
  // A prompt that never sends anything: the session only answers control requests.
  const never: AsyncIterable<never> = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<never>>(() => {}) }),
  };
  const q = sdkQuery({
    prompt: never,
    options: {
      pathToClaudeCodeExecutable: binaryPath,
      env: loginOnlyEnv(),
      settingSources: [],
      abortController: abort,
    },
  });
  try {
    return await q.supportedModels();
  } finally {
    abort.abort();
  }
}
