import type { EffortLevel } from "./capabilities.js";
import type { IonEvent } from "./events.js";

/** Close code sent when a connection has a missing or wrong token. */
export const UNAUTHORIZED_CLOSE = 4401;

export type ProjectInfo = {
  id: string;
  path: string;
  starred: boolean;
  access?: "auto" | "full";
  shareWithIon?: boolean;
};

export type StatusResult = {
  version: string;
  pid: number;
  uptimeS: number;
  projects: number;
  configError: string | null;
};

/** Every command the daemon accepts: its arguments and its result. */
export type Commands = {
  status: { args: Record<string, never>; result: StatusResult };
  "projects.list": { args: Record<string, never>; result: ProjectInfo[] };
  "projects.add": { args: { path: string }; result: ProjectInfo };
  "project.create": { args: { name: string }; result: ProjectInfo };
  "project.setAccess": { args: { projectId: string; access: "auto" | "full" }; result: { ok: true } };
  "chat.create": { args: { title: string; projectId?: string | null }; result: IonEvent };
  /** fromNow: only events from now on, no backlog. */
  "events.subscribe": {
    args: { chatId?: string; afterId?: string; fromNow?: boolean };
    result: { sub: string };
  };
  ask: {
    args: {
      text: string;
      chatId?: string;
      projectId?: string;
      harness?: string;
      model?: string;
      effort?: EffortLevel;
      /** This message's access mode; else the project's, else the default. */
      access?: "auto" | "full";
    };
    result: { chatId: string; runId: string };
  };
  "run.interrupt": { args: { runId: string }; result: { ok: true } };
  "needs.list": { args: { chatId?: string }; result: NeedInfo[] };
  /**
   * Answers an agent's question: choice number `choice` (1-based), or `text` in your own words. Scope defaults to
   * this chat.
   */
  "need.answer": {
    args: { needId: string; choice?: number; text?: string; scope?: DecisionScope };
    result: { ok: true };
  };
  "decisions.list": { args: { projectId?: string }; result: DecisionInfo[] };
  "decision.note": { args: { decisionId: string; text: string }; result: { ok: true } };
  "decision.forget": { args: { decisionId: string }; result: { ok: true } };
  "chats.list": { args: Record<string, never>; result: ChatInfo[] };
  "chat.archive": { args: { chatId: string }; result: { ok: true } };
  /** What a chat changed in its worktree since it started (empty once archived); omitted: files past the cap. */
  "chat.diff": { args: { chatId: string }; result: { files: FileDiff[]; omitted?: number } };
  "memory.list": { args: { projectId?: string }; result: MemoryInfo[] };
  "memory.forget": { args: { memoryId: string }; result: { ok: true } };
  "harnesses.list": { args: Record<string, never>; result: HarnessInfo[] };
};

export type HarnessInfo = {
  id: string;
  label: string;
  installed: boolean;
  signedIn: boolean;
  /** From the harness itself when it's signed in; empty otherwise. */
  models: { id: string; label: string }[];
  defaultModel: string | null;
};

export type MemoryInfo = {
  memoryId: string;
  /** "you", or the project it belongs to. */
  scope: string;
  text: string;
  /** "you", or the chat it came from. */
  source: string;
  writtenAt: string;
};

export type NeedInfo = {
  needId: string;
  chatId: string;
  runId: string;
  projectId: string | null;
  kind: string;
  summary: string;
  /** The exact input the agent sent (command, path, URL…), or why it asks, not its own description. */
  detail: string | null;
  /** An agent's question: the choices you pick from. */
  choices?: { label: string; consequence: string; recommended?: boolean }[];
  /** ion's own question about a tool call it stopped. */
  blocked?: boolean;
  raisedAt: string;
};

export type FileDiff = { path: string; added: number; removed: number; patch: string; truncated?: true };

export type DecisionScope = "chat" | "project" | "everywhere";

export type DecisionInfo = {
  decisionId: string;
  projectId: string;
  chatId: string | null;
  question: string;
  choice: string;
  scope: DecisionScope;
  by: "you" | "ion";
  decidedAt: string;
  outcomes: { kind: "ran" | "failed" | "note"; text: string; by: "ion" | "agent" | "you" }[];
};

export type ChatInfo = {
  chatId: string;
  title: string;
  projectId: string | null;
  branch: string | null;
  archived: boolean;
  lastRunStatus: string | null;
};
export type Command = keyof Commands;
export const COMMANDS = [
  "status",
  "projects.list",
  "projects.add",
  "project.create",
  "project.setAccess",
  "chat.create",
  "events.subscribe",
  "ask",
  "run.interrupt",
  "needs.list",
  "need.answer",
  "decisions.list",
  "decision.note",
  "decision.forget",
  "chats.list",
  "chat.archive",
  "chat.diff",
  "memory.list",
  "memory.forget",
  "harnesses.list",
] as const;

export type ApiError = { code: "unknown_command" | "bad_request" | "invalid" | "internal"; message: string };
export type Request<C extends Command = Command> = { id: string; cmd: C; args: Commands[C]["args"] };
export type Reply<C extends Command = Command> =
  | { id: string; ok: true; result: Commands[C]["result"] }
  | { id: string; ok: false; error: ApiError };
export type Push = { sub: string; event: IonEvent };
