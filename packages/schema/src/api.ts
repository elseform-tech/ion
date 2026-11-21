import type { EffortLevel } from "./capabilities.js";
import type { IonEvent } from "./events.js";
import type {
  ImportInfo,
  ImportResult,
  NewHook,
  Picks,
  RegistryHit,
  ServerTools,
  ToolAdd,
  ToolCheck,
  ToolItem,
  ToolType,
  ToolsInfo,
} from "./tools.js";

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

/** A routine's next run, for Activity. `next` is null while it, or every routine, is paused. */
export type UpcomingRun = {
  projectId: string;
  routineId: string;
  name: string;
  when: string;
  /** Its ion's name (the project's). */
  ion: string;
  next: string | null;
  /** The effort it runs at: its own, else its project's; null: the agent's default. */
  effort: EffortLevel | null;
  on: boolean;
  /** You skipped its next run (`next` is the one after). */
  skipped: boolean;
};

/** One run of an ion's thread: its title, ion, how it went, what it cost and when it started. */
export type RecentRun = {
  runId: string;
  chatId: string;
  title: string;
  projectId: string;
  ion: string;
  /** The routine that started it, if one did. */
  routine: string | null;
  status: string;
  costUsd: number | null;
  at: string;
};

/** Activity: pause all, what's next (soonest first), and ion threads' runs today and yesterday (newest first). */
export type ActivityInfo = {
  paused: boolean;
  upcoming: UpcomingRun[];
  today: RecentRun[];
  yesterday: RecentRun[];
};

/** One of ion chief's open suggestions: a routine for something you keep asking for, or a stalled chat to resume. */
export type SuggestionInfo = {
  suggestionId: string;
  kind: "routine" | "stalled";
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
  /** Why your config file didn't load (what's shown are the defaults), in plain words naming the file. */
  problem?: string;
};

/** What Settings changes: only the given fields; notifications by part; `ownTools` by agent. */
export type SettingsPatch = Partial<Pick<SettingsInfo, "maxRuns" | "quick" | "effort" | "ownTools">> & {
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
export type Commands = {
  status: { args: Record<string, never>; result: StatusResult };
  "projects.list": { args: Record<string, never>; result: ProjectInfo[] };
  "projects.add": { args: { path: string }; result: ProjectInfo };
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
  "ions.list": { args: Record<string, never>; result: IonInfo[] };
  "ion.message": { args: { ionId: string; text: string }; result: { ok: true } };
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
  "memory.list": { args: { projectId?: string }; result: MemoryInfo[] };
  "memory.forget": { args: { memoryId: string }; result: { ok: true } };
  "harnesses.list": { args: Record<string, never>; result: HarnessInfo[] };
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
  /** Connections from mcp.json, your hooks, and what each agent can take. */
  "tools.list": { args: Record<string, never>; result: ToolsInfo };
  /** Turns a connection, a hook or a skill on or off (kept in ion's config, never in mcp.json). */
  "tools.setOn": {
    args: { kind: "mcp" | "hook" | "skill" | "repo"; id: string; on: boolean };
    result: ToolsInfo;
  };
  /** Keeps a key for `${name}` in a server of mcp.json (`id`), in the keychain (never in config or the log). */
  "tools.setKey": { args: { id: string; name: string; key: string }; result: ToolsInfo };
  "tools.addHook": { args: NewHook; result: ToolsInfo };
  /** null clears the project (every project's events). */
  "tools.updateHook": {
    args: { id: string } & Partial<Omit<NewHook, "project">> & { project?: string | null };
    result: ToolsInfo;
  };
  "tools.removeHook": { args: { id: string }; result: ToolsInfo };
  /**
   * Starts signing in to a remote server (OAuth): the page the app opens in your browser. A server that can't
   * register ion needs a client ID (and maybe a secret, kept in the keychain).
   */
  "tools.signIn": { args: { id: string; clientId?: string; clientSecret?: string }; result: { url: string } };
  /** Forgets a remote server's sign-in (its tokens and any client secret). */
  "tools.signOut": { args: { id: string }; result: ToolsInfo };
  /** The official MCP Registry's servers for a name: how each runs, the keys it needs, its source. */
  "tools.search": { args: { query: string }; result: RegistryHit[] };
  /** Adds a connection, skill or hook, off (you turn it on in Settings → Tools); a literal key is refused. */
  "tools.add": { args: ToolAdd; result: ToolItem };
  /** Whether it's valid, where it came from, and whether it's on. */
  "tools.verify": { args: { kind: ToolType; name: string }; result: ToolCheck };
  /** Safe checks (never starting anything off); for a local server that's on, its tools. No name: every one. */
  "tools.doctor": { args: { kind: ToolType; name?: string }; result: ToolCheck[] };
  /** Removes one (a chat's agent: only what a chat added). */
  "tools.remove": { args: { kind: ToolType; name: string }; result: { ok: true } };
  /** Every connection, skill or hook of this kind, on or off, with where it came from. */
  "tools.items": { args: { kind: ToolType }; result: ToolItem[] };
  /** The servers in your agents' own configs that aren't in mcp.json (read only now; nothing is run or contacted). */
  "tools.importable": { args: Record<string, never>; result: ImportInfo };
  /** Adds them to mcp.json, off, keys left out as `${NAME}`s: one agent's, these names, or every one listed. */
  /** `repo`: a project's own file (`shop:.mcp.json`): its servers come in only when it's named. */
  "tools.import": { args: { agent?: string; names?: string[]; repo?: string }; result: ImportResult };
  /** Hides the Import line (one agent's, or every one) until a server ion hasn't seen appears. */
  "tools.dismissImport": { args: { agent?: string }; result: ImportInfo };
  /**
   * What "/" and "@" list in a message box (the user, 2026-11-21): a chat's agent's own skills and commands and ion's
   * that reach it, and its servers; for an ion's chat (`ionId`), the skills and servers that ion's threads can use.
   */
  "tools.picks": { args: { harness?: string; projectId?: string | null; ionId?: string }; result: Picks };
  /** A server's tools (from its tools/list; only one that's on), each with whether ions can use it. */
  "tools.serverTools": { args: { id: string }; result: ServerTools };
  /** "Ions can use" for one of a server's tools: your switch, kept with what the tool is now. */
  "tools.setIonUse": { args: { id: string; tool: string; on: boolean }; result: { ok: true } };
};

export type HarnessInfo = {
  id: string;
  label: string;
  installed: boolean;
  signedIn: boolean;
  /** From the harness itself when it's signed in; empty otherwise. */
  models: { id: string; label: string }[];
  defaultModel: string | null;
  /** With "Use its own tools" off, it still loads MCP servers, hooks or plugins of its own (no switch for them all). */
  ownTools?: true;
  /** Its own hooks run in ion's chats too (no switch for them). */
  ownHooks?: true;
  /** What "Use its own tools" off really turns off, by kind. Absent: all of it. */
  ownOff?: { servers: boolean; skills: boolean; plugins: boolean };
  /** It trusts a project's own tools by its own list. */
  ownTrust?: true;
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
export type AskBrain = Pick<Commands["ask"]["args"], "harness" | "model" | "effort" | "access">;

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
  "memory.forget",
  "harnesses.list",
  "routine.add",
  "routine.update",
  "routine.remove",
  "routine.run",
  "routines.pause",
  "activity.list",
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

export type ApiError = { code: "unknown_command" | "bad_request" | "invalid" | "internal"; message: string };
export type Request<C extends Command = Command> = { id: string; cmd: C; args: Commands[C]["args"] };
export type Reply<C extends Command = Command> =
  | { id: string; ok: true; result: Commands[C]["result"] }
  | { id: string; ok: false; error: ApiError };
export type Push = { sub: string; event: IonEvent };
