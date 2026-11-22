import type { Access } from "../access/index.js";
import type { TheirRules } from "../access/agent-rules.js";
import type { Grants } from "../mcp/index.js";
import type { RunSkills } from "../skills/run.js";
import type { PickSource } from "../skills/picks.js";
import type { RunOwn } from "../tools/own-run.js";
import type { RunAgent, RunServers } from "../tools/run-servers.js";
import type { AskBlocked, AskingRun, BeforeTool } from "./approvals.js";
import type { MemoryFiles } from "./history.js";
import type { SandboxCtx } from "./sandbox.js";

/** What the run manager is given: ion's config and data folders, and what each run's checks and tools come from. */
export type RunCtx = {
  configFile: string;
  dataDir: string;
  random?: () => number;
  /** Auto access: rules, then the judge (a quick model). Without it, Auto denies. */
  access?: Access;
  /**
   * ion's MCP server: each run gets a key for its own project, revoked when the run ends; and ion's memory: a new
   * session starts with the index of what its chat may see.
   */
  mcp?: { grants: Grants; url: () => string; memory?: MemoryFiles };
  ionBin?: string; // ion's own `ion` launcher's folder, first on every run's PATH

  /** ion's gate (`<base>/<key>`): harnesses with a hook report every tool call there before it runs. */
  gate?: { url: () => string };
  /** Asks you about a tool call ion stopped (the call waits for the answer). */
  askBlocked?: AskBlocked;
  /** Your "Before a tool runs" hooks (Settings → Tools → Hooks). */
  beforeTool?: BeforeTool;
  /** A run's agent's own allow and deny rules, from your settings for it (they count as your decisions). */
  theirs?: (r: AskingRun) => TheirRules | null;
  /** Your MCP servers for a chat's run on this agent, and the ones it goes without (Settings → Tools). */
  servers?: (agent: RunAgent) => Promise<RunServers>;
  /** Your skills for a chat's run: a plugin folder made for it (null: none, or its agent doesn't take them). */
  skills?: RunSkills;
  /** What a chat's run brings of its agent's own (its servers, skills and plugins; "Use its own tools"). */
  own?: RunOwn;
  /** What "/" and "@" can pick for a chat on this agent in this project (a message's picks resolve here). */
  picks?: (agent: string, projectId: string) => Promise<PickSource>;
} & SandboxCtx;
