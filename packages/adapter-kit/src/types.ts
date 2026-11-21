import type { Capabilities, Decision, EffortLevel, NewEvent } from "@ion/schema";
import type { EnvDrop } from "./run-env.js";

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
  | { name: string; transport: "stdio"; command: string; args: string[]; env: Record<string, string> };

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
  /** Added to the agent process's environment (a chat's run: `ION_CHAT`, which its tool calls' processes inherit). */
  env?: Record<string, string>;
  /** What the agent's process may not inherit from ion's environment (your keys: mcp.json's names and values). */
  envDrop?: EnvDrop;
  signal: AbortSignal;
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

export type AuthStatus = { signedIn: boolean; method: string };

export interface HarnessAdapter {
  id: string;
  detect(): Promise<{ installed: boolean; version?: string; path?: string }>;
  auth: { status(): Promise<AuthStatus>; login(): Promise<void> };
  capabilities(): Promise<Capabilities>;
  /** The kinds of MCP server it takes from ion (a server of another kind is left out of its runs). */
  mcpTransports: McpTransports;
  /** It also loads MCP servers, hooks or plugins of its own in ion's chats (it has no switch to leave them out). */
  ownTools?: true;
  start(opts: StartOpts): Promise<Session>;
  /** The harness's hook payload as one tool call (null if it isn't one). Only harnesses that install a gate hook. */
  gateCall?(payload: unknown): GateCall | null;
}
