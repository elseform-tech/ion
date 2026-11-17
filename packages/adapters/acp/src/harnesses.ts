/** How to launch and sign in to an ACP agent. */
export type AcpHarness = {
  id: string;
  label: string;
  bin: string;
  args: string[];
  versionArgs: string[];
  loginArgs: string[];
  loginHint: string;
  defaultModel: string | null;
  /** Extra environment for the agent (e.g. making it ask before editing). */
  env?: () => Record<string, string>;
  /** `_meta` sent with `session/new` (agent-specific session options). */
  sessionMeta?: Record<string, unknown>;
};

export const GROK_BUILD: AcpHarness = {
  id: "grok-build",
  label: "Grok Build",
  bin: "grok",
  // The command line outranks the user's config.toml (where permission_mode may be "always-approve").
  args: ["--permission-mode", "default", "agent", "stdio"],
  versionArgs: ["--version"],
  loginArgs: ["login"],
  loginHint: "grok login",
  defaultModel: null,
  // Always ask ion before tools run, whatever the user's own Grok permission mode is.
  sessionMeta: { yoloMode: false, autoMode: false },
  env: grokAskEnv,
};

/**
 * The session meta alone doesn't stop a user's `permission_mode = "always-approve"` from running shell
 * commands unasked: GROK_CONFIG (above the user's config.toml) starts ion's sessions in ask mode, and
 * read-only commands ask too, since they can read outside the worktree.
 */
function grokAskEnv(): Record<string, string> {
  return { GROK_CONFIG: JSON.stringify({ ui: { permission_mode: "ask" } }), GROK_ASK_LOCAL_READS: "false" };
}

export const OPENCODE: AcpHarness = {
  id: "opencode",
  label: "opencode",
  bin: "opencode",
  args: ["acp"],
  versionArgs: ["--version"],
  loginArgs: ["auth", "login"],
  loginHint: "opencode auth login",
  // A free model, so trying ion costs nothing.
  defaultModel: "opencode/big-pickle",
  env: opencodeAskEnv,
};

/** opencode's own config with edits, shell and web fetches set to ask, merged into any inline config. */
function opencodeAskEnv(): Record<string, string> {
  let base: Record<string, unknown> = {};
  try {
    base = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}");
  } catch {
    // ignore an unreadable inline config; ion's permissions still apply
  }
  const ask = { edit: "ask", bash: "ask", webfetch: "ask" };
  const permission = { ...((base.permission as object) ?? {}), ...ask };
  // Agent-level permissions win over top-level ones, so set them too.
  const baseAgents = (base.agent ?? {}) as Record<string, Record<string, unknown>>;
  const agent = {
    ...baseAgents,
    build: { ...baseAgents.build, permission: { ...(baseAgents.build?.permission as object), ...ask } },
    plan: { ...baseAgents.plan, permission: { ...(baseAgents.plan?.permission as object), ...ask } },
  };
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...base, permission, agent }),
    // A repo's own opencode.json could set permissions back to "allow" (verified): don't load it.
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  };
}
