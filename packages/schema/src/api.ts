import type { EffortLevel } from "./capabilities.js";
import type { IonEvent } from "./events.js";

/** Close code sent when a connection has a missing or wrong token. */
export const UNAUTHORIZED_CLOSE = 4401;

export type ProjectInfo = { id: string; path: string; starred: boolean; access?: "auto" | "full" };

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
  "project.setAccess": { args: { projectId: string; access: "auto" | "full" }; result: { ok: true } };
  "chat.create": { args: { title: string; projectId?: string | null }; result: IonEvent };
  "events.subscribe": { args: { chatId?: string; afterId?: string }; result: { sub: string } };
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
  "need.resolve": {
    args: { needId: string; decision: "allow" | "deny" };
    result: { ok: true };
  };
  "chats.list": { args: Record<string, never>; result: ChatInfo[] };
  "chat.archive": { args: { chatId: string }; result: { ok: true } };
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
  /** The exact input the agent sent (command, path, URL…), not its own description. */
  detail: string | null;
  raisedAt: string;
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
  "project.setAccess",
  "chat.create",
  "events.subscribe",
  "ask",
  "run.interrupt",
  "needs.list",
  "need.resolve",
  "chats.list",
  "chat.archive",
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
