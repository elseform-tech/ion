import type { Billing, Capabilities, Decision, EffortLevel, NewEvent } from "@ion/schema";
import type { PickStyle } from "./picks.js";
import type { AgentLogin, AgentLogout } from "./login.js";
import type { EnvDrop } from "./run-env.js";
import type { RunSandbox } from "./sandbox.js";

/** What an adapter emits. The daemon stamps chatId, runId and origin ("adapter") before storing. */
export type AdapterEvent = Omit<NewEvent, "chatId" | "runId" | "origin">;

/** One tool call the harness wants permission for. */
export type ApprovalRequest = {
  requestId: string;
  toolId: string;
  toolName: string;
  kind: string;
  summary: string;
  input: Record<string, unknown>;
  /** For an MCP tool: the server it belongs to, when the harness says (ion's own is "ion"). */
  mcpServer?: string | null;
};

export type { Decision };

/** One tool call as a harness's own pre-tool hook reports it to ion's gate (before the tool runs). */
export type GateCall = Pick<ApprovalRequest, "toolName" | "kind" | "summary" | "input" | "mcpServer">;

/** The harness couldn't continue the session it was given (gone, expired): start a new one instead. */
export class ResumeFailed extends Error {}

/**
 * One MCP server for a run, its values already filled in (they may hold keys and tokens): an adapter keeps them off
 * the agent's command line and out of events and logs.
 */
export type McpSpec =
  | HttpMcpSpec
  | {
      name: string;
      transport: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
      /**
       * A repo's own server you allowed for this chat: it runs from the project's own folder (the checkout ion read
       * its .mcp.json from, which chats don't write), never the chat's worktree (security review, 2026-11-21).
       */
      cwd?: string;
    };

/** A remote (Streamable HTTP) MCP server: the only kind a run's agent is given (a local one is ion's URL for it). */
export type HttpMcpSpec = { name: string; transport: "http"; url: string; headers: Record<string, string> };

/**
 * Which MCP servers an agent takes from ion: remote (Streamable HTTP). Your local ones reach it the same way (ion runs
 * them and serves each at its own URL), so an agent that takes http takes both.
 */
export type McpTransports = { http: boolean };

/** ion's own server's name in a run's list. */
export const ION_SERVER = "ion";

export type StartOpts = {
  cwd: string;
  model: string | null;
  effort: EffortLevel | null;
  instructions?: string;
  /** The harness's own session id, to continue a conversation. */
  resume?: string;
  /** A plain model call (ion's judge): no tools at all, a short system prompt, one turn, no thinking. */
  bare?: boolean;
  /**
   * No web at all (ion's dream): the agent's own web search and fetch are off, ion's MCP server stays. Only on an
   * adapter with `noWeb`; `bareHome` holds what it needs for that (Grok's profile).
   */
  noWeb?: boolean;
  /**
   * A bare start's daemon-only folder for the agent's own files (Grok's profile): outside its working folder, only read
   * by the agent (PR #25 review, 2026-11-22).
   */
  bareHome?: string;
  /** ion's gate for this run: the harness's pre-tool hook sends every tool call here before it runs. */
  gate?: { url: string };
  /**
   * The run's MCP servers: ion's own first (named `ion`: history, needs and memory of its project), then the ones you
   * turned on (a chat's runs only), each at ion's URL for it. Passed per run; ion never writes an agent's own config.
   */
  mcpServers?: HttpMcpSpec[];
  /**
   * A plugin folder of the skills you turned on (a chat's run, on an agent that takes skills from ion): made in ion's
   * data folder for this run, never in the worktree.
   */
  pluginDir?: string;
  /**
   * The agent brings its own MCP servers, skills and plugins (a chat's run with "Use its own tools" on; the user,
   * 2026-11-21). Its own hooks and permission rules stay off wherever the agent can turn them off: ion's gate judges
   * every call. Absent or false: ion's tools only.
   */
  ownTools?: boolean;
  /** With `ownTools`, Claude Code's own enabled plugins: folders (a plugin with hooks is ion's copy without them). */
  ownPlugins?: string[];
  /** Added to the agent process's environment (a chat's run: `ION_CHAT`, which its tool calls' processes inherit). */
  env?: Record<string, string>;
  /** What the agent's process may not inherit from ion's environment (your keys: mcp.json's names and values). */
  envDrop?: EnvDrop;
  /**
   * The run's sandbox (a chat's run, on a computer that has one): ion's folders out of reach of the agent and every
   * process it starts, the run's own paths let through. The adapter applies it its own way (`HarnessAdapter.sandbox`).
   */
  sandbox?: RunSandbox;
  signal: AbortSignal;
  /**
   * When ion is holding one of the run's calls for your answer (through any path: its gate too), so an agent's silence
   * check waits (re-review, 2026-11-21).
   */
  holding?: { on(listener: (held: boolean) => void): void };
  /** The daemon decides every permission prompt (policy now, a "Needs you" pin in Plan 3). */
  decide: (req: ApprovalRequest) => Promise<Decision>;
};

export interface Session {
  /** ion's id for this session; `nativeId` is the harness's own (for resume). */
  id: string;
  nativeId: string | null;
  send(input: { text: string }): Promise<void>;
  /** Ends after `run.finished`. */
  events(): AsyncIterable<AdapterEvent>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

/** Signed in or not, how, and how that sign-in bills (absent: unknown, never taken as free). */
export type AuthStatus = { signedIn: boolean; method: string; billing?: Billing };

/** By kind: whether an agent's switch turns its own off in ion's chats. */
type OwnOff = { servers: boolean; skills: boolean; plugins: boolean };

export interface HarnessAdapter {
  id: string;
  detect(): Promise<{ installed: boolean; version?: string; path?: string }>;
  /**
   * Whether it's signed in, and how you sign in and out: its own commands, which ion runs only where they need no
   * terminal (a page or a code to show; the user, 2026-11-23).
   */
  auth: { status(): Promise<AuthStatus>; login: AgentLogin; logout: AgentLogout };
  capabilities(): Promise<Capabilities>;
  /** The kinds of MCP server it takes from ion (a server of another kind is left out of its runs). */
  mcpTransports: McpTransports;
  /**
   * With "Use its own tools" off, it still loads MCP servers, hooks or plugins of its own in ion's chats (it has no
   * switch to leave them all out).
   */
  ownTools?: true;
  /** Its own hooks run in ion's chats too (it has no switch for them). */
  ownHooks?: true;
  /** It can start with its own web search and fetch off (`StartOpts.noWeb`). */
  noWeb?: true;
  /** What "Use its own tools" off really turns off, by kind (task review, 2026-11-21). Absent: all of it. */
  ownOff?: OwnOff;
  /** It decides by itself whether to trust a project's own tools (its own trust list). */
  ownTrust?: true;
  /** How it takes what you picked with "/" (picks.ts): "slash", it runs `/command` itself. Absent: "tell". */
  picks?: PickStyle;
  /** It reads an MCP server's resources (so "@" lists them for it). */
  mcpResources?: true;
  /**
   * About how many tokens its default model's context holds: a chat's history longer than a quarter of it (at most
   * 100,000 characters) reaches a new session as ion's summary and the last messages (runs/history.ts). Absent: 128,000.
   */
  contextTokens?: number;
  /**
   * How its runs are sandboxed (docs/research/sandbox.md): "own", its own sandbox told to keep ion's folders out
   * (Codex); "ion", ion's wrapper around its process (the rest). Absent: never (the fake agent starts no process).
   */
  sandbox?: "own" | "ion";
  /**
   * How it bills for these models (null: its default), asked of the agent itself (opencode: its own price list);
   * undefined when it can't tell. Absent: its sign-in says (`auth.status`).
   */
  billingOf?(models: (string | null)[]): Promise<Billing | undefined>;
  start(opts: StartOpts): Promise<Session>;
  /** The harness's hook payload as one tool call (null if it isn't one). Only harnesses that install a gate hook. */
  gateCall?(payload: unknown): GateCall | null;
}
