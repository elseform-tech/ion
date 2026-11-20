import type { Capabilities, Decision, EffortLevel, NewEvent } from "@ion/schema";

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
  /** ion's MCP server for this run: history, needs and memory of its project. */
  mcp?: { name: "ion"; url: string; headers: Record<string, string> };
  /** Added to the agent process's environment (a chat's run: `ION_CHAT`, which its tool calls' processes inherit). */
  env?: Record<string, string>;
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
  start(opts: StartOpts): Promise<Session>;
  /** The harness's hook payload as one tool call (null if it isn't one). Only harnesses that install a gate hook. */
  gateCall?(payload: unknown): GateCall | null;
}
