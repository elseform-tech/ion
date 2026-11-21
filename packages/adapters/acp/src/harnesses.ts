import type { GateCall } from "@ion/adapter-kit";
import { type GateEnv, grokGateEnv, grokToCall, OPENCODE_PLUGIN, opencodeToCall } from "./gate.js";
import { carriedConfig, settingUp, userConfigHome, writeIonConfig } from "./opencode-config.js";

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
  /** Extra environment for the agent (e.g. making it ask before editing); with a gate, its hook too. */
  env?: (gate?: GateEnv, own?: boolean) => Record<string, string>;
  /** The agent's gate-hook payload as one tool call. */
  toCall?: (payload: unknown) => GateCall | null;
  /** `_meta` sent with `session/new` (agent-specific session options). */
  sessionMeta?: Record<string, unknown>;
  /** How long an agent may say nothing at all after a prompt before the run fails (default 2 minutes). */
  silenceMs?: number;
  /**
   * Whether it takes remote MCP servers (ACP's `mcpCapabilities.http`; stdio is every agent's baseline). Default
   * true: opencode 1.18.8 and Grok 1.0.89 both say so (checked live, 2026-11-20); a session leaves them out anyway
   * when the agent's `initialize` doesn't.
   */
  mcpHttp?: boolean;
  /** With "Use its own tools" off, it still loads MCP servers, hooks or plugins of its own: no switch for them all. */
  ownTools?: true;
  /** Its own hooks run in ion's chats too: it has no switch for them. */
  ownHooks?: true;
  /** What a start that timed out says instead of "didn't respond" (an agent still setting up); none: the usual. */
  notResponding?: (own?: boolean) => string | undefined;
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
  env: (gate, own) => ({ ...grokAskEnv(), ...grokOwnToolsEnv(own), ...(gate ? grokGateEnv(gate) : {}) }),
  toCall: grokToCall,
  // Its own config.toml servers, ~/.grok/hooks and plugins have no switch (GROK_CONFIG can't set them; GROK_HOME
  // moves its sign-in too). Checked on Grok 1.0.92: docs/research/acp-and-harnesses.md.
  ownTools: true,
  ownHooks: true,
};

/**
 * Grok's switches for what it reads from Claude Code (~/.claude.json servers and skills, ~/.claude/settings.json hooks)
 * and Cursor. Hooks stay ion's always (the user, 2026-11-21); servers and skills only with "Use its own tools" off.
 */
function grokOwnToolsEnv(own?: boolean): Record<string, string> {
  const hooks = ["CLAUDE_HOOKS", "CURSOR_HOOKS"];
  // Skills too (task review, 2026-11-21): Grok's own ~/.grok skills stay; Claude's and Cursor's aren't read.
  const off = own ? hooks : [...hooks, "CLAUDE_MCPS", "CLAUDE_SKILLS", "CURSOR_MCPS", "CURSOR_SKILLS"];
  return Object.fromEntries(off.map((k) => [`GROK_${k}_ENABLED`, "false"]));
}

/**
 * Grok's local read-only tools (stat, find, du…) ask like other commands where Grok honours this. Its own question
 * card is off: it calls back into a client that has no card to show ("Method not found"), so Grok asks through
 * ion's ask tool instead.
 */
function grokAskEnv(): Record<string, string> {
  return { GROK_ASK_LOCAL_READS: "false", GROK_ASK_USER_QUESTION: "false" };
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
  toCall: opencodeToCall,
  // ~/.opencode/plugin and the plugins listed in ~/.opencode's config still load: opencode has no switch for that
  // folder short of moving HOME (which moves its sign-in). Task review, 2026-11-21.
  ownTools: true,
  // opencode's plugins are hook code: with your own tools, yours run too.
  ownHooks: true,
  notResponding: (own) => (settingUp(own) ? "Not responding — opencode is setting up, try again" : undefined),
};

/**
 * opencode with edits, shell and web fetches set to ask, ion's plugin as its only plugin, and none of its own servers
 * (opencode-config.ts). The config is a file in ion's folder, never the environment (task review, 2026-11-21: your
 * provider keys reached every process opencode started); only the gate's address is in env.
 */
function opencodeAskEnv(gate?: GateEnv, own = false): Record<string, string> {
  const base = carriedConfig(own);
  const ask = { edit: "ask", bash: "ask", webfetch: "ask" };
  const permission = { ...((base.permission as object) ?? {}), ...ask };
  // Agent-level permissions win over top-level ones, so set them too.
  const baseAgents = (base.agent ?? {}) as Record<string, Record<string, unknown>>;
  const agent = {
    ...baseAgents,
    build: { ...baseAgents.build, permission: { ...(baseAgents.build?.permission as object), ...ask } },
    plan: { ...baseAgents.plan, permission: { ...(baseAgents.plan?.permission as object), ...ask } },
  };
  // ion's plugin reports every tool call to ion before it runs (with a gate; without one it does nothing). Listed
  // always, so the config is the same for every start and the daemon's first sign-in check installs what opencode needs
  // for it, not a chat's start (live, 2026-11-21: a first chat timed out waiting on that install).
  // Your own plugins (with your own tools) after ion's, which is always first and always there.
  const yours = (Array.isArray(base.plugin) ? base.plugin : []).filter((p) => p !== OPENCODE_PLUGIN);
  const home = writeIonConfig({ ...base, permission, agent, plugin: [OPENCODE_PLUGIN, ...yours] }, own);
  return {
    ...(gate ? { ION_GATE_URL: gate.url } : {}),
    // An inline config in ion's own environment is carried into the file, never passed on.
    OPENCODE_CONFIG_CONTENT: "",
    // A repo's own opencode.json could set permissions back to "allow" (verified): don't load it.
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    // Your own config folder, file and folder (their servers and plugins) aren't loaded; ion's plugin gives the
    // commands opencode runs your config folder back.
    XDG_CONFIG_HOME: home,
    ION_XDG_CONFIG_HOME: userConfigHome(),
    OPENCODE_CONFIG: "",
    OPENCODE_CONFIG_DIR: "",
  };
}
