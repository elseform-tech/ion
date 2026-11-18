import type { GateCall } from "@ion/adapter-kit";
import { type GateEnv, grokGateEnv, grokToCall, OPENCODE_PLUGIN, opencodeToCall } from "./gate.js";

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
  env?: (gate?: GateEnv) => Record<string, string>;
  /** The agent's gate-hook payload as one tool call. */
  toCall?: (payload: unknown) => GateCall | null;
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
  env: (gate) => ({ ...grokAskEnv(), ...(gate ? grokGateEnv(gate) : {}) }),
  toCall: grokToCall,
};

/** Grok's local read-only tools (stat, find, du…) ask like other commands where Grok honours this. */
function grokAskEnv(): Record<string, string> {
  return { GROK_ASK_LOCAL_READS: "false" };
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
};

/** opencode's own config with edits, shell and web fetches set to ask, merged into any inline config. */
function opencodeAskEnv(gate?: GateEnv): Record<string, string> {
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
  // With a gate: ion's plugin reports every tool call to ion before it runs.
  const plugin = gate ? { plugin: [...((base.plugin as unknown[]) ?? []), OPENCODE_PLUGIN] } : {};
  return {
    ...(gate ? { ION_GATE_URL: gate.url } : {}),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...base, permission, agent, ...plugin }),
    // A repo's own opencode.json could set permissions back to "allow" (verified): don't load it.
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  };
}
