import type { EffortLevel } from "./capabilities.js";
import type { IonEvent } from "./events.js";

/** Close code sent when a connection has a missing or wrong token. */
export const UNAUTHORIZED_CLOSE = 4401;

export type ProjectInfo = { id: string; path: string; starred: boolean };

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
      allowEdits?: boolean;
    };
    result: { chatId: string; runId: string };
  };
  "run.interrupt": { args: { runId: string }; result: { ok: true } };
  "needs.list": { args: { chatId?: string }; result: NeedInfo[] };
  "need.resolve": {
    args: { needId: string; decision: "allow" | "allow_always" | "deny" };
    result: { ok: true };
  };
  "chats.list": { args: Record<string, never>; result: ChatInfo[] };
  "chat.archive": { args: { chatId: string }; result: { ok: true } };
};

export type NeedInfo = {
  needId: string;
  chatId: string;
  runId: string;
  projectId: string | null;
  kind: string;
  summary: string;
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
  "chat.create",
  "events.subscribe",
  "ask",
  "run.interrupt",
  "needs.list",
  "need.resolve",
  "chats.list",
  "chat.archive",
] as const;

export type ApiError = { code: "unknown_command" | "bad_request" | "invalid" | "internal"; message: string };
export type Request<C extends Command = Command> = { id: string; cmd: C; args: Commands[C]["args"] };
export type Reply<C extends Command = Command> =
  | { id: string; ok: true; result: Commands[C]["result"] }
  | { id: string; ok: false; error: ApiError };
export type Push = { sub: string; event: IonEvent };
