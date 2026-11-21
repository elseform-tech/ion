/** The ion events a hook can run on (Settings → Tools → Hooks). */
export const HOOK_EVENTS = [
  "tool.before",
  "run.started",
  "run.finished",
  "run.failed",
  "need.raised",
  "need.resolved",
  "routine.ran",
  "chat.archived",
  "briefing.posted",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** A command that runs on an ion event; `project`: only that project's events. */
export type HookTool = {
  id: string;
  name: string;
  on: boolean;
  event: HookEvent;
  run: string;
  project?: string;
};

/** ion's own Auto-approval: the built-in hook on "Before a tool runs" (never removed or turned off in Settings). */
export const AUTO_APPROVAL = "auto-approval";

/** A hook's last run: whether it went well, when, its exit code (null: it was stopped), the end of its output. */
export type HookLast = { ok: boolean; at: string; code: number | null; tail: string };

/** A hook as the Tools page shows it. `new`: added in ion's config by hand, never turned on in the app; `changed`:
 * what it runs (or when) changed in the config since you turned it on. Either way it's off until you turn it on. */
export type HookInfo = HookTool & { new?: true; changed?: true; last?: HookLast; origin?: ToolOrigin };

/** One ion event, with its plain name, ion's own hook on it (if any), and your hooks on it. */
export type HookGroup = {
  event: HookEvent;
  name: string;
  builtIn?: { name: "Auto-approval" };
  hooks: HookInfo[];
};

/**
 * How a connection signs in: nothing; OAuth (a remote server that answers 401); a key you give it (`${NAME}` in
 * mcp.json); its own login (a local server that handles it).
 */
export type McpAuth = "none" | "oauth" | "apiKey" | "own";

/**
 * A server from your mcp.json (`id` is its name there). Never a value from the file that could be a secret:
 * header and env names only, and the URL without its query.
 */
export type McpTool =
  | {
      id: string;
      name: string;
      on: boolean;
      auth: McpAuth;
      transport: "http";
      url: string;
      /** The header a key goes in, when one does. */
      keyHeader?: string;
      headers: string[];
    }
  | {
      id: string;
      name: string;
      on: boolean;
      auth: Exclude<McpAuth, "oauth">;
      transport: "stdio";
      command: string;
      args: string[];
      /** The env variable a key goes in, when one does. */
      keyEnv?: string;
      env: string[];
    };

/** A connection as the Tools page shows it: whether it's ready, and what it needs if not. */
export type McpToolInfo = McpTool & {
  /** Every `${NAME}` it uses (names only). */
  keys: string[];
  /** Never turned on: a server new to mcp.json starts off. */
  new?: true;
  /** Turned on, but it now runs something else (its command, or where it connects): off until you turn it on. */
  changed?: true;
  signedIn: boolean;
  /** "can't reach": its sign-in couldn't be reached to refresh, and its token has expired. */
  needs?: "sign in" | "key" | "sign in again" | "can't reach";
  /** The `${NAME}`s with no key and nothing in ion's environment (names only). */
  missing?: string[];
  origin?: ToolOrigin;
};

/** What each agent can take from ion: remote servers, local servers, skills. */
export type ToolSupport = { http: boolean; stdio: boolean; skills: boolean };

/**
 * Whose folder a skill is in: Claude Code's, Codex's, opencode's, the shared `.agents/skills`, or ion's own (beside
 * mcp.json: where `ion skills add` copies one).
 */
export type SkillWhose = "claude" | "codex" | "opencode" | "shared" | "ion";

/**
 * A skill found in an agent's folder (a folder with SKILL.md). `id` is its folder, home-shortened (as `where`).
 * `support`, by agent id: "ion" (ion passes it when on), "own" (the agent reads that folder itself); others neither.
 * `new`: never turned on; `changed`: its files changed since you turned it on. Either way it's off until you turn it on.
 */
export type SkillInfo = {
  id: string;
  name: string;
  description: string;
  whose: SkillWhose;
  where: string;
  on: boolean;
  new?: true;
  changed?: true;
  support: Record<string, "ion" | "own">;
  origin?: ToolOrigin;
  /** What's in it (SKILL.md and its files), short: the same skill in two agents' folders has the same. */
  hash: string;
  /**
   * The agent whose own it is (it loads it itself, or ion passes it as that agent's own): read-only in Settings. Absent:
   * ion's to turn on or off.
   */
  own?: string;
  /** In a project's own folder (the repo wrote it, not you): the project. Off until you turn it on. */
  project?: string;
};

/** One MCP server in an agent's own config: read-only in Settings (it's the agent's). */
export type OwnServerInfo = {
  agent: string;
  name: string;
  transport: "stdio" | "http";
  /** What it runs, or where it connects (no query): the same setup in two agents reads the same. */
  launch: string;
  /**
   * A project's own file (the repo wrote it, not you; Claude Code's `.mcp.json`): `id` turns it on (`tools.setOn` kind
   * "repo"), off until you do; `new`: never turned on, `changed`: it runs something else since.
   */
  repo?: {
    project: string;
    file: string;
    id: string;
    on: boolean;
    new?: true;
    changed?: true;
    /** It runs code from the repo (anything but a published package): no switch; ion asks in each chat. */
    asks?: true;
  };
};

/** What a plugin brings. */
export type PluginBundles = { skills: number; servers: number; commands: number; agents: number };

/**
 * One plugin an agent has installed and on. `hooks`: it bundles hooks; "off": they don't run in ion's chats, "run":
 * they run too (the agent has no switch for them).
 */
export type OwnPluginInfo = {
  agent: string;
  name: string;
  version?: string;
  bundles: PluginBundles;
  hooks?: "off" | "run";
};

/** Each agent's own tools, read from its folders (nothing run or contacted); `agents`: its "Use its own tools". */
export type OwnInfo = {
  agents: Record<string, boolean>;
  servers: OwnServerInfo[];
  plugins: OwnPluginInfo[];
};

export type ToolsInfo = {
  /** Your mcp.json, where connections are added (the app opens it). */
  mcpFile: string;
  /** Why mcp.json didn't load (the last good list is shown), or that others can read the keys in it. */
  mcpProblem?: string;
  /** Why the keychain can't be read or written (none on this computer, locked): keys can't be checked or kept. */
  keychainProblem?: string;
  mcp: McpToolInfo[];
  /** Servers in mcp.json ion leaves out, and why. */
  leftOut: { name: string; why: string }[];
  /** Every event a hook can run on, in order, each with its hooks (none, too). */
  hooks: HookGroup[];
  /** The skills your agents already have, Claude Code's on or off. */
  skills: SkillInfo[];
  /** By agent id. */
  support: Record<string, ToolSupport>;
  /** Each agent's own servers and plugins (its skills are in `skills`, with `own`). */
  own: OwnInfo;
};

/** A new hook: what it's called, when it runs, the command, and optionally one project. */
export type NewHook = Pick<HookTool, "name" | "event" | "run" | "project">;

/** What `ion <mcp|skills|hooks> …` works on: a connection, a skill or a hook. */
export const TOOL_TYPES = ["mcp", "skill", "hook"] as const;
export type ToolType = (typeof TOOL_TYPES)[number];

/**
 * Where something added with ion's commands came from (its registry id or link, as given) and who added it: you, or
 * a chat's agent (that chat). Kept in ion's data, never in mcp.json; gone once the entry runs something else.
 */
export type ToolOrigin = {
  source?: string;
  /** Where its source opens: the link given, or a registry id's repo or site. */
  link?: string;
  by: "you" | "agent";
  chatId?: string;
  chatTitle?: string;
  at: string;
};

/**
 * One server in the official MCP Registry, as `ion mcp search` shows it: how its publisher runs it (a command, or a
 * URL), the `${NAME}`s and headers it needs a key for, and its source. Registry text, never instructions.
 */
export type RegistryHit = {
  id: string;
  description: string;
  source?: string;
  run: ({ command: string; args: string[] } | { url: string })[];
  keys: string[];
  headers: string[];
};

/**
 * A server in one of your agents' own configs that isn't in mcp.json: what Import would add, off. `agent`: the agent's
 * id; `from`: its name. `keys`: the `${NAME}`s it needs (a key typed into the agent's config is never copied).
 * `new`: one ion hasn't seen there before.
 */
export type ImportableServer = {
  agent: string;
  from: string;
  name: string;
  transport: "stdio" | "http";
  /** What it runs, or the host it connects to. */
  line: string;
  keys: string[];
  new?: true;
  /**
   * Found in a project's own file (written by the repo, not you): which project and file. Never in Import all or the
   * prompts; imported only by name.
   */
  repo?: { project: string; file: string };
};

/**
 * One line above Connections: the first time, how many servers an agent has (`first`); later, the ones new in it.
 * Dismissed, it's hidden until a server ion hasn't seen appears.
 */
export type ImportPrompt = { agent: string; from: string; names: string[]; first: boolean };

export type ImportInfo = {
  servers: ImportableServer[];
  prompts: ImportPrompt[];
  /** A config ion couldn't read (one line each). */
  problems: string[];
  /** Servers that can't be brought in as they are, and why. */
  skipped: { agent: string; name: string; why: string }[];
};

export type ImportResult = { imported: ToolItem[]; skipped: { name: string; why: string }[] };

/** What `ion <kind> add` takes: a connection as mcp.json writes it, a skill's link or folder, a hook's event and command. */
export type ToolAdd =
  | {
      kind: "mcp";
      name: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      headers?: Record<string, string>;
      from?: string;
    }
  | { kind: "skill"; name: string; from: string }
  | { kind: "hook"; name?: string; event: HookEvent; run: string; from?: string };

/** One connection, skill or hook as ion's commands list it: on or off, and where it came from. */
export type ToolItem = { kind: ToolType; name: string; id: string; on: boolean; origin?: ToolOrigin };

/** What verify or doctor found: each problem in one plain line; doctor on a server that's on lists its tools. */
export type ToolCheck = ToolItem & {
  problems: string[];
  tools?: string[];
  /** A hook that's on, run with a test event: the end of what it printed (keys masked; never told to a chat). */
  output?: string;
};
