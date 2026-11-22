import { closeSync, constants, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GateCall, SandboxPaths } from "@ion/adapter-kit";
import type { EffortLevel } from "@ion/schema";
import { type GateEnv, grokGateEnv, grokToCall, OPENCODE_PLUGIN, opencodeToCall } from "./gate.js";
import {
  carriedConfig,
  ownSkillPaths,
  ionConfigHome,
  settingUp,
  userConfigHome,
  writeIonConfig,
} from "./opencode-config.js";

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
  /** What its switch really turns off, by kind. */
  ownOff?: { servers: boolean; skills: boolean; plugins: boolean };
  /** It trusts a project's own tools by its own list. */
  ownTrust?: true;
  /** How it takes what you picked with "/": "slash", it runs `/command` (ACP's available commands) itself. */
  picks?: "slash" | "tell";
  /**
   * Reads one line of the agent's own log (stderr): the reason a turn failed, when the line says one (opencode's
   * "stream error … error.error=…"). With it, the agent is started with its log on stderr.
   */
  logFailure?: (line: string) => string | null;
  /** What a start that timed out says instead of "didn't respond" (an agent still setting up); none: the usual. */
  notResponding?: (own?: boolean) => string | undefined;
  /**
   * Whether it's ready to start in a run's sandbox (opencode: its plugin package installed in ion's folder). Not yet:
   * ion opens it once outside the sandbox first, with no prompt, so it sets itself up there.
   */
  prepare?: (own?: boolean) => boolean;
  /** Its own paths in a run's sandbox: what of ion's it reads, and its config, which a run can't write. */
  sandboxPaths?: (own?: boolean) => Partial<SandboxPaths>;
  /**
   * A bare start (ion's judge): its fast model and low effort (when ion's config names none), and its command line
   * with no tools, given the judge's folder (Grok: an agent profile there that allows none).
   */
  bare?: { model?: string; effort?: EffortLevel; args?: (dir: string) => string[] };
  /** Its own command that deletes a session from its history (ion's judge sessions don't pile up among yours). */
  forgetArgs?: (sessionId: string) => string[];
};

/** Grok's folder: `$GROK_HOME`, else `~/.grok`. */
const grokHome = () => process.env.GROK_HOME ?? join(homedir(), ".grok");

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
  // Only what it reads from Claude Code and Cursor can be turned off; its own servers, skills and plugins stay.
  ownOff: { servers: false, skills: false, plugins: false },
  // A project's own .grok config loads by its folder trust.
  ownTrust: true,
  // Its hooks (ion's gate among them), config, skills and plugins (installed-plugins holds an enabled plugin's files and
  // its registry; config.toml says which are on): nothing a run does lasts into the next (final review, 2026-11-22).
  sandboxPaths: () => ({
    noWrite: ["hooks", "config.toml", "skills", "installed-plugins", "plugins"].map((f) =>
      join(grokHome(), f),
    ),
  }),
  // ion's judge: its fast model at low effort, with a profile that leaves it no tool of consequence (final review,
  // 2026-11-22; GROK_CONFIG's toolset can't remove tools, `--tools` doesn't reach `agent stdio`, a profile does).
  bare: { model: "grok-4.7-build-fast", effort: "low", args: grokBareArgs },
  forgetArgs: (id) => ["sessions", "delete", id],
};

/**
 * Grok for ion's judge: an agent profile in ion's folder for it (`dir`, daemon-only, outside the session's folder) whose only tool is its todo list (a profile needs one;
 * `search_tool`/`use_tool` stay, and ion's gate refuses them), no servers inherited, no shared leader.
 */
function grokBareArgs(dir: string): string[] {
  const file = join(dir, "ion-judge.md");
  const profile = [
    "---",
    "name: ion-judge",
    "description: Answers one question for ion",
    "tools: todo_write",
    "mcpInheritance: none",
    "---",
    "Answer the user's message directly, in the format it asks for. You have no tools.",
    "",
  ].join("\n");
  // Written fresh: whatever is in its place goes, and the new file is made, never opened through a link.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  rmSync(file, { force: true });
  const fd = openSync(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, profile);
  } finally {
    closeSync(fd);
  }
  return ["--permission-mode", "default", "agent", "--agent-profile", file, "--no-leader", "stdio"];
}

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

/** Known failures, said in ion's own words (automated review, 2026-11-21). */
const KNOWN: [RegExp, string][] = [
  [/free usage|usage limit/i, "opencode's free usage is used up — try again later or pick another model"],
];

/** A logged reason as text that's safe to show: no URL or query, nothing that looks like a key, at most 200 chars. */
function cleanReason(why: string): string {
  return why
    .replace(/\bhttps?:\/\/\S+/gi, "")
    .replace(/\?\S*/g, "")
    .replace(/\bBearer\s+\S+/gi, "")
    .replace(/\b[\w-]*(key|token|secret|password|auth)[\w-]*\s*[=:]\s*\S+/gi, "")
    .replace(/\b\S*(key|token|secret|password|sk-|ghp_)\S*/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200 - "opencode: ".length);
}

/**
 * opencode's log line for a failed model call (live, 2026-11-21: out of its free quota it said so only there): a
 * known case in ion's words, else "opencode: <its reason>", cleaned; null for any other line.
 */
export function opencodeFailure(line: string): string | null {
  if (!line.includes("stream error")) return null;
  const why = /error\.error="((?:[^"\\]|\\.)*)"/.exec(line)?.[1]?.replace(/^AI_\w+: /, "");
  if (!why) return null;
  const known = KNOWN.find(([re]) => re.test(why));
  return known ? known[1] : `opencode: ${cleanReason(why)}`;
}

export const OPENCODE: AcpHarness = {
  id: "opencode",
  label: "opencode",
  bin: "opencode",
  // Its log (warnings and errors) on stderr: a turn that fails quietly (out of quota) says why there.
  args: ["acp", "--print-logs", "--log-level", "WARN"],
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
  // Off: its servers and skills stay out; ~/.opencode's plugins still load.
  ownOff: { servers: true, skills: true, plugins: false },
  // opencode runs a prompt that starts with `/command` as that command (its ACP agent lists them).
  picks: "slash",
  notResponding: (own) => (settingUp(own) ? "Not responding — opencode is setting up, try again" : undefined),
  // ion's folder for it (its config, its plugin package, which ion has opencode install outside the sandbox first:
  // `prepare`) is only read by a run; your own config folders aren't written. The sandbox can't tell opencode from the
  // commands it runs: they can read that config too (docs/research/sandbox.md).
  prepare: (own) => !settingUp(own),
  sandboxPaths: (own) => ({
    read: [ionConfigHome(own)],
    noWrite: [join(userConfigHome(), "opencode"), join(homedir(), ".opencode")],
  }),
  logFailure: opencodeFailure,
  // ion's judge: its free model, low effort; every tool refused by ion's gate (final review, 2026-11-22).
  bare: { effort: "low" },
  forgetArgs: (id) => ["session", "delete", id],
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
  // Your own plugins (with your own tools), then ion's, always there and last, so it judges a call as your plugins
  // left it (task review, 2026-11-21; opencode loads plugins in the order listed: not checked live).
  const yours = (Array.isArray(base.plugin) ? base.plugin : []).filter((p) => p !== OPENCODE_PLUGIN);
  const skills = own ? { skills: { ...(base.skills as object), paths: ownSkillPaths(base) } } : {};
  const home = writeIonConfig(
    { ...base, permission, agent, ...skills, plugin: [...yours, OPENCODE_PLUGIN] },
    own,
  );
  return {
    ...(gate ? { ION_GATE_URL: gate.url } : {}),
    // An inline config in ion's own environment is carried into the file, never passed on.
    OPENCODE_CONFIG_CONTENT: "",
    // A repo's own opencode.json could set permissions back to "allow" (verified): don't load it.
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    // Skills only from the folders ion names (with your own tools): none it finds by itself (~/.claude, a project's).
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    // Your own config folder, file and folder (their servers and plugins) aren't loaded; ion's plugin gives the
    // commands opencode runs your config folder back.
    XDG_CONFIG_HOME: home,
    ION_XDG_CONFIG_HOME: userConfigHome(),
    OPENCODE_CONFIG: "",
    OPENCODE_CONFIG_DIR: "",
  };
}
