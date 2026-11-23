import type { EffortLevel } from "./capabilities.js";
import type { ActivityInfo } from "./activity.js";
import type { IonEvent } from "./events.js";
import type { ToolsCommands } from "./tools-api.js";
import type { DreamInfo, DreamMode, MemoryChangeInfo, MemoryFileInfo, MemoryInfo } from "./memory.js";
import type { MemorySee, MemoryType } from "./memory.js";
import { AGENT_COMMANDS, type AgentCommands, type AgentUsage, type TaskEstimate } from "./agents.js";

/** Close code sent when a connection has a missing or wrong token. */
export const UNAUTHORIZED_CLOSE = 4401;

export type ProjectInfo = {
  id: string;
  path: string;
  starred: boolean;
  /** The name ion shows, when you renamed it; else its id. */
  name?: string;
  shareWithIon?: boolean;
  /** Its ion's colour and the agent its ion's threads run on (Plan 09). */
  color?: string;
  harness?: string;
  /** The model and effort its ion's threads run on. */
  model?: string;
  effort?: "low" | "medium" | "high" | "max";
  /** What its ion does on a schedule. */
  routines?: RoutineInfo[];
  /** What the project is, in your words (at most 300 characters). */
  profile?: string;
  /** A profile its ion suggested: only used once you accept it. */
  profileSuggestion?: string;
};

/** Something a project's ion does on a schedule (`when`: see parseWhen): a thread titled `name`, briefed `text`. */
export type RoutineInfo = {
  id: string;
  name: string;
  when: string;
  text: string;
  on: boolean;
  effort?: EffortLevel;
  /** The due time (ISO) of the one run you skipped. */
  skip?: string;
};

/**
 * One of the ions' open suggestions: a routine for something you keep asking for, a stalled chat to resume, or a
 * to-do a chat's work matches ("Mark done?").
 */
export type SuggestionInfo = {
  suggestionId: string;
  kind: "routine" | "stalled" | "todo";
  projectId: string;
  /** What it asks: "Make Weekly PR summary a routine?", "Resume Tailwind 4 migration?". */
  title: string;
  /** Its evidence, in a few words: "Fridays 17:00 · asked on 3 days", "Stalled 6 days · 3 files". */
  detail: string;
  /** When ion suggested it. */
  at: string;
};

/** A routine's fields to change; null clears effort (the project's again). skip: skip its next run, or undo that. */
export type RoutinePatch = {
  projectId: string;
  routineId: string;
  name?: string;
  when?: string;
  text?: string;
  on?: boolean;
  effort?: EffortLevel | null;
  skip?: boolean;
};

/** What Settings can change about a project's ion: each field set, or null to clear it. */
export type ProjectPatch = {
  projectId: string;
  harness?: string | null;
  color?: string | null;
  model?: string | null;
  effort?: "low" | "medium" | "high" | "max" | null;
  shareWithIon?: boolean | null;
  profile?: string | null;
  /** Only cleared (you accepted or dismissed it): only its ion suggests a profile. */
  profileSuggestion?: null;
};

/** ion's own models: "quick" thinks for ion chief and the project ions ("<agent>" or "<agent>:<model>"). */
/** ion's own model: "<agent>" or "<agent>:<model>", and how hard it thinks (null: the agent's default). */
export type IonSettings = { quick: string; effort: EffortLevel | null };

/** What ion does when a chat's agent hits its limit (Settings → Agents). */
export type OnLimit = "ask" | "continue" | "wait";

/** How much a project may notify: everything, what needs you, only urgent things, nothing. */
export type NotifyLevel = "all" | "needs" | "digest" | "muted";

/** Every setting: ion's model, then General and Notifications. */
export type SettingsInfo = IonSettings & {
  maxRuns: "auto" | number;
  /** How many chats Auto lets work at once on this computer (half its cores, at least one). */
  autoRuns: number;
  notifications: {
    briefing: { on: boolean; at: string };
    quiet: { on: boolean; from: string; to: string };
    /** By project id. */
    projects: Record<string, NotifyLevel>;
  };
  /** By agent id: "Use its own tools" (its own servers, skills and plugins in ion's chats). */
  ownTools: Record<string, boolean>;
  /** ion tidies your memory overnight: how often, and on which agent (null: ion's own model's). */
  dream: { mode: DreamMode; agent: string | null };
  /** Memory everywhere (yours follows it), and in each project, by id (as it is: its own, else everywhere's). */
  memory: { on: boolean; projects: Record<string, boolean> };
  /**
   * Your agent order, best first (every agent ion knows): handoff targets, Pick by usage, and an ion's chats when the
   * project names no agent.
   */
  agentOrder: string[];
  /** When a chat's agent hits its limit: ask you, continue on the next agent, or wait for the reset. */
  onLimit: OnLimit;
  /** Pick by usage: a new chat you picked no agent for goes on the one with room, by fit and cost. */
  byUsage: boolean;
  /** Why your config file didn't load (what's shown are the defaults), in plain words naming the file. */
  problem?: string;
};

/** What Settings changes: only the given fields; notifications by part; `ownTools` by agent. */
export type SettingsPatch = Partial<
  Pick<SettingsInfo, "maxRuns" | "quick" | "effort" | "ownTools" | "agentOrder" | "onLimit" | "byUsage">
> & {
  dream?: { mode?: DreamMode; agent?: string | null };
  /** Memory on or off everywhere, or in a project (set like everywhere, it follows everywhere again). */
  memory?: { on?: boolean; projects?: Record<string, boolean> };
  notifications?: {
    briefing?: Partial<SettingsInfo["notifications"]["briefing"]>;
    quiet?: Partial<SettingsInfo["notifications"]["quiet"]>;
    projects?: Record<string, NotifyLevel>;
  };
};

/**
 * A process a chat's agent left running, in its worktree or anywhere else. `where`: "" in the worktree, null when
 * unknown, else its working folder, your home shown as ~.
 */
export type TaskInfo = {
  pid: number;
  command: string;
  elapsed: string;
  ports: number[];
  where: string | null;
};

/** A file a chat's runs made, as the Artifacts tab lists it; `path` is relative to the worktree. */
export type ArtifactInfo = {
  path: string;
  size: number;
  changedAt: string;
  kind: "image" | "html" | "text" | "binary";
};

/** A file as the preview shows it: text, HTML (rendered locked), an image, or a binary it can't show. */
export type FilePreview =
  | { path: string; kind: "text" | "html"; text: string; size: number }
  | { path: string; kind: "image"; dataUrl: string; size: number }
  | { path: string; kind: "binary"; size: number };

/** The lab's ion colours, by name, in the order new projects take them. */
export const ION_COLORS: { name: string; hex: string }[] = [
  { name: "Orange", hex: "#ED712E" },
  { name: "Green", hex: "#5BC67A" },
  { name: "Amber", hex: "#F19D38" },
  { name: "Blue", hex: "#3C82F6" },
  { name: "Purple", hex: "#885CF5" },
  { name: "Teal", hex: "#54B9A6" },
  { name: "Pink", hex: "#EB4699" },
  { name: "Red", hex: "#EA4045" },
  { name: "Brown", hex: "#97683D" },
];

/** Runs over the last 30 days: how many, how many succeeded, their cost, runs per day (oldest first). */
export type IonStats = { runs: number; succeeded: number; costUsd: number; perDay: number[] };

export type StatusResult = {
  version: string;
  pid: number;
  uptimeS: number;
  projects: number;
  configError: string | null;
  /** Things worth a look, one line each (e.g. "Auto often isn't sure about: npm publish"). */
  notes?: string[];
};

/** Every command the daemon accepts: its arguments and its result. */
export interface Commands extends ToolsCommands, AgentCommands {
  status: { args: Record<string, never>; result: StatusResult };
  "projects.list": { args: Record<string, never>; result: ProjectInfo[] };
  /**
   * Adds a folder. One that isn't a git repo gets ion's git setup first (`gitSetUp`): a new repo, your files its
   * first commit. Refused for your home folder and for one too big to set up.
   */
  "projects.add": { args: { path: string }; result: ProjectInfo & { gitSetUp?: true } };
  "project.create": { args: { name: string }; result: ProjectInfo };
  "project.star": { args: { projectId: string; starred: boolean }; result: { ok: true } };
  /** Shows the project under a new name (its id stays). */
  "project.rename": { args: { projectId: string; name: string }; result: { ok: true } };
  /** Takes the project out of ion: its chats are archived; its folder is never touched. */
  "project.remove": { args: { projectId: string }; result: { ok: true } };
  /** A project's ion setup and rules; null clears a field (back to the default). */
  "project.update": { args: ProjectPatch; result: { ok: true } };
  /** ion's own models (Settings → Agents). */
  "settings.get": { args: Record<string, never>; result: SettingsInfo };
  /** Saves the given settings and returns them all; a bad value is refused with its reason. */
  "settings.set": { args: { patch: SettingsPatch }; result: SettingsInfo };
  /** An ion's threads' runs over the last 30 days (ion chief: every ion's). */
  "ion.stats": { args: { ionId: string }; result: IonStats };
  /** What a chat's agent left running (dev servers, watchers), wherever it runs, with PIDs and ports. */
  "chat.tasks": { args: { chatId: string }; result: TaskInfo[] };
  /** The files a chat's runs made (newest first, at most 200); none until it has a workspace. */
  "chat.artifacts": { args: { chatId: string }; result: ArtifactInfo[] };
  /** Stops one of them (only if it's still that chat's). */
  "task.stop": { args: { chatId: string; pid: number }; result: { ok: true } };
  /** A file in a chat's worktree, for the preview (at most 1 MB). */
  "chat.file": { args: { chatId: string; path: string }; result: FilePreview };
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
      /** Skills and commands picked with "/" (by name): the agent is told to use them, the way it expects. */
      skills?: string[];
      /** MCP servers or resources picked with "@" (by name). */
      mentions?: string[];
      /** Don't remember this chat: it gets no memory and writes none (`ion ask --no-memory`). */
      noMemory?: boolean;
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
  "chat.rename": { args: { chatId: string; title: string }; result: { ok: true } };
  /** Remember (on) or Don't remember (off) the chat. */
  "chat.remember": { args: { chatId: string; on: boolean }; result: { ok: true } };
  "ions.list": { args: Record<string, never>; result: IonInfo[] };
  /** `skills`, `mentions`: what you picked with "/" and "@" (the ion reads them, or passes them to a thread). */
  "ion.message": {
    args: { ionId: string; text: string; skills?: string[]; mentions?: string[] };
    result: { ok: true };
  };
  /**
   * Stops the ion's turn answering your message (Stop, Esc twice; a report goes on): it says it stopped, and what's
   * queued waits ("Stopped") until you send one now, change the queue or send a message. `stopped`: one was going.
   */
  "ion.stop": { args: { ionId: string }; result: { ok: true; stopped: boolean } };
  /** What waits to go to a chat or an ion, oldest first. */
  "queue.list": { args: { to: QueueTarget }; result: QueuedInfo[] };
  /** Queues a message (at most 10 wait per chat or ion); it goes out when the work ends. */
  "queue.add": { args: { to: QueueTarget; text: string; brain: AskBrain }; result: { queueId: string } };
  "queue.remove": { args: { queueId: string }; result: { ok: true } };
  /** Takes it out of the queue to edit: its text, unless it was already sent. */
  "queue.take": { args: { queueId: string }; result: { text: string } };
  /** Sends it next: the chat's run (the ion's turn) stops, the others keep their order. */
  "queue.sendNow": { args: { queueId: string }; result: { ok: true } };
  /** keep: take it (add the routine, resume the chat); mute: not now, and no more like it for that project. */
  "suggestion.answer": {
    args: { suggestionId: string; keep: boolean; mute?: boolean };
    result: { ok: true };
  };
  "suggestions.list": { args: Record<string, never>; result: SuggestionInfo[] };
  /** What a chat changed in its worktree since it started (empty once archived); omitted: files past the cap. */
  "chat.diff": { args: { chatId: string }; result: { files: FileDiff[]; omitted?: number } };
  /** Yours and a project's files (or all), open to-dos first, then the latest; `open`: open to-dos only. */
  "memory.list": { args: { projectId?: string; type?: MemoryType; open?: boolean }; result: MemoryInfo[] };
  /** One file, by its path, file name or name. */
  "memory.read": { args: { name: string }; result: MemoryFileInfo };
  /**
   * The best matches for some words (at most 20), yours and a project's (or all); `scope` ("you" or a project's id):
   * only that scope's files.
   */
  "memory.search": { args: { q: string; projectId?: string; scope?: string }; result: MemoryInfo[] };
  /** Deletes a file, by its path, file name or name. */
  "memory.forget": { args: { memoryId: string }; result: { ok: true } };
  /** Keeps a chat's suggested preference for every project (by its path or name). */
  "memory.keep": { args: { path: string }; result: { path: string } };
  /** Each change to a file, newest first: who, when, and the text it left. */
  "memory.history": { args: { path: string }; result: MemoryChangeInfo[] };
  /** Changes a file's text or who sees it, as you, only over the version read (`expect`: its hash). */
  "memory.write": {
    args: { path: string; text?: string; see?: MemorySee; expect: string };
    result: MemoryInfo;
  };
  /** Where the memory folder is, and each file in it that can't be read (one plain line). */
  "memory.folder": { args: Record<string, never>; result: { path: string; problems: string[] } };
  /** Brings back a file ion forgot (or you did), as it was, by you; refused while a file is there. */
  "memory.restore": { args: { path: string }; result: MemoryInfo };
  /** What ion's dream did last, within a day of it (null: nothing to say). */
  "memory.tidied": { args: Record<string, never>; result: DreamInfo | null };
  /** ion tidies your memory now (its dream, out of turn); what it did. */
  "memory.dream": { args: Record<string, never>; result: DreamInfo | null };
  /** A new to-do: yours, or a project's; `due` a day (YYYY-MM-DD). */
  "todo.add": { args: { text: string; projectId?: string; due?: string }; result: MemoryInfo };
  /** Marks a to-do done, by its path, file name or name. */
  "todo.done": { args: { name: string }; result: MemoryInfo };
  "routine.add": {
    args: { projectId: string; name: string; when: string; text: string; effort?: EffortLevel };
    result: RoutineInfo;
  };
  "routine.update": { args: RoutinePatch; result: { ok: true } };
  "routine.remove": { args: { projectId: string; routineId: string }; result: { ok: true } };
  /** Runs it now, whatever its schedule: the thread it started. */
  "routine.run": { args: { projectId: string; routineId: string }; result: { chatId: string } };
  /** Pause all: no routine runs until you resume. */
  "routines.pause": { args: { paused: boolean }; result: { ok: true } };
  "activity.list": { args: Record<string, never>; result: ActivityInfo };
  /** Each listed agent's usage: tokens and cost, its windows, its limit, how it bills. */
  "usage.list": { args: Record<string, never>; result: AgentUsage[] };
  /**
   * What a task usually takes, from similar past chats in its project: a new chat's request (on the agent named, else
   * the one it would go on), or a chat already started (left out of its own history). Null with too few to say.
   */
  "usage.estimate": {
    args: { chatId: string } | { projectId: string | null; harness?: string; text: string };
    result: TaskEstimate | null;
  };
}

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
  /** Its answer can't be remembered (the action's input was cut): no Remember. */
  noRemember?: true;
  /** In an ion thread: the project's ion's one line of context. */
  via?: { note: string };
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
  /** When it last had a message or a run (ISO time). */
  lastActivityAt: string | null;
  /** The start of the agent's last reply, on one line. */
  preview: string | null;
  /** "ion": a thread ion started; null: your own chat. */
  by: "ion" | null;
  /** You picked Don't remember: it gets no memory and writes none. */
  notRemembered?: true;
  /**
   * What the chat waits for, while it does: one of ion's slots ("Waiting — 4 ion chats running"), or its agent's
   * reset after a limit ("Waits for Codex — 16:20").
   */
  waiting?: string;
};

/** An ion: ion chief ("chief") or a project's ion (its id is the project's). */
export type IonInfo = {
  ionId: string;
  name: string;
  /** Its colour (identity only); null for ion chief. */
  color: string | null;
  /** The agent its threads run on; null: ion chief, or the default. */
  harness: string | null;
  /** The last thing it said. */
  last: string | null;
  /** Open questions in its threads (ion chief: all). */
  needs: number;
  /** One of its threads is running. */
  working: boolean;
  /** Its own turn is going (or waiting): Enter queues, Esc twice stops it. */
  thinking: boolean;
  /** Its project is starred (Starred first); ion chief never is. */
  starred: boolean;
};
/** Where a queued message goes: a chat, or an ion (ion chief "chief", or a project's ion). */
export type QueueTarget = { chatId: string } | { ionId: string };

/** What the message box picks for a message: its agent, model, effort and access (each optional, as for ask). */
export type AskBrain = Pick<
  Commands["ask"]["args"],
  "harness" | "model" | "effort" | "access" | "skills" | "mentions"
>;

/** A message waiting to go out. */
export type QueuedInfo = {
  queueId: string;
  text: string;
  brain: AskBrain;
  addedAt: string;
  /** Why it couldn't go out, when its last try failed (it holds the queue until you send it now, edit or remove it). */
  why?: string;
  /** It waits for your answer to the agent's question (or for your answers to go in first). */
  held?: "answer";
};

export type Command = keyof Commands;
export const COMMANDS = [
  "status",
  "projects.list",
  "projects.add",
  "project.create",
  "project.star",
  "project.rename",
  "project.remove",
  "project.update",
  "settings.get",
  "ion.stats",
  "chat.tasks",
  "chat.artifacts",
  "task.stop",
  "chat.file",
  "settings.set",
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
  "chat.rename",
  "chat.remember",
  "ions.list",
  "ion.message",
  "ion.stop",
  "queue.list",
  "queue.add",
  "queue.remove",
  "queue.take",
  "queue.sendNow",
  "suggestion.answer",
  "suggestions.list",
  "chat.diff",
  "memory.list",
  "memory.read",
  "memory.search",
  "memory.forget",
  "memory.keep",
  "memory.history",
  "memory.write",
  "memory.folder",
  "memory.restore",
  "memory.tidied",
  "memory.dream",
  "todo.add",
  "todo.done",
  ...AGENT_COMMANDS,
  "routine.add",
  "routine.update",
  "routine.remove",
  "routine.run",
  "routines.pause",
  "activity.list",
  "usage.list",
  "usage.estimate",
  "tools.list",
  "tools.setOn",
  "tools.setKey",
  "tools.addHook",
  "tools.updateHook",
  "tools.removeHook",
  "tools.signIn",
  "tools.signOut",
  "tools.search",
  "tools.add",
  "tools.verify",
  "tools.doctor",
  "tools.remove",
  "tools.items",
  "tools.importable",
  "tools.import",
  "tools.dismissImport",
  "tools.picks",
  "tools.serverTools",
  "tools.setIonUse",
] as const;

/** `confirm`: ion asks you first (the message is its question); the same call with `confirm: true` goes ahead. */
export type ApiError = { code: ApiErrorCode; message: string };
type ApiErrorCode = "unknown_command" | "bad_request" | "invalid" | "confirm" | "internal";
export type Request<C extends Command = Command> = { id: string; cmd: C; args: Commands[C]["args"] };
export type Reply<C extends Command = Command> =
  | { id: string; ok: true; result: Commands[C]["result"] }
  | { id: string; ok: false; error: ApiError };
export type Push = { sub: string; event: IonEvent };
