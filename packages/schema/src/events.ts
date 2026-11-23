import { z } from "zod";
import { IonCardSchema, PICKED } from "./ion-cards.js";
import { memoryEventSchemas } from "./memory.js";
import { usageEventSchemas } from "./usage-events.js";

export const SCHEMA_VERSION = 1;

/** Emitted by harness adapters: translations of one CLI's output. */
export const ADAPTER_EVENT_TYPES = [
  "run.started",
  "run.finished",
  "message.delta",
  "message.completed",
  "thinking.delta",
  "tool.started",
  "tool.output",
  "tool.finished",
  "file.changed",
  "approval.requested",
  "artifact.attached",
  "usage.reported",
  "error",
] as const;

/** Emitted only by the daemon (the ion layer). */
export const DAEMON_EVENT_TYPES = [
  "chat.created",
  "chat.archived",
  "chat.renamed",
  "ion.heard",
  "ion.said",
  "ion.session",
  "suggestion.answered",
  "message.sent",
  "run.queued",
  "run.waiting",
  "run.retrying",
  "approval.resolved",
  "need.raised",
  "need.resolved",
  "route.sent",
  "claim.checked",
  "checks.finished",
  "routine.proposed",
  "routine.ran",
  "briefing.written",
  "signal.raised",
  "proposal.made",
  "proposal.answered",
  "memory.written",
  "memory.forgotten",
  "memory.dreamed",
  "decision.recorded",
  "decision.outcome",
  "decision.forgotten",
  "queue.added",
  "queue.removed",
  "queue.sent",
  "queue.failed",
  "notify",
  "briefing.posted",
  "todo.reminded",
  "tool.signedIn",
  "tool.signedOut",
  "tool.needsSignIn",
  "tool.skipped",
  "tool.added",
  "hook.ran",
  "chat.handoff",
] as const;

export const EVENT_TYPES = [...ADAPTER_EVENT_TYPES, ...DAEMON_EVENT_TYPES] as const;

/** Use these instead of string literals outside this package (lint: ion/event-types-from-schema). */
export const EV = {
  runStarted: "run.started",
  runFinished: "run.finished",
  messageDelta: "message.delta",
  messageCompleted: "message.completed",
  thinkingDelta: "thinking.delta",
  toolStarted: "tool.started",
  toolOutput: "tool.output",
  toolFinished: "tool.finished",
  fileChanged: "file.changed",
  approvalRequested: "approval.requested",
  artifactAttached: "artifact.attached",
  usageReported: "usage.reported",
  error: "error",
  chatCreated: "chat.created",
  chatArchived: "chat.archived",
  chatRenamed: "chat.renamed",
  ionHeard: "ion.heard",
  ionSaid: "ion.said",
  ionSession: "ion.session",
  suggestionAnswered: "suggestion.answered",
  messageSent: "message.sent",
  runQueued: "run.queued",
  runWaiting: "run.waiting",
  runRetrying: "run.retrying",
  approvalResolved: "approval.resolved",
  needRaised: "need.raised",
  needResolved: "need.resolved",
  routeSent: "route.sent",
  claimChecked: "claim.checked",
  checksFinished: "checks.finished",
  routineProposed: "routine.proposed",
  routineRan: "routine.ran",
  briefingWritten: "briefing.written",
  signalRaised: "signal.raised",
  proposalMade: "proposal.made",
  proposalAnswered: "proposal.answered",
  memoryWritten: "memory.written",
  memoryForgotten: "memory.forgotten",
  memoryDreamed: "memory.dreamed",
  decisionRecorded: "decision.recorded",
  decisionOutcome: "decision.outcome",
  decisionForgotten: "decision.forgotten",
  queueAdded: "queue.added",
  queueRemoved: "queue.removed",
  queueSent: "queue.sent",
  queueFailed: "queue.failed",
  notify: "notify",
  briefingPosted: "briefing.posted",
  todoReminded: "todo.reminded",
  toolSignedIn: "tool.signedIn",
  toolSignedOut: "tool.signedOut",
  toolNeedsSignIn: "tool.needsSignIn",
  toolSkipped: "tool.skipped",
  toolAdded: "tool.added",
  hookRan: "hook.ran",
  chatHandoff: "chat.handoff",
} as const satisfies Record<string, EventType>;

export type AdapterEventType = (typeof ADAPTER_EVENT_TYPES)[number];
export type DaemonEventType = (typeof DAEMON_EVENT_TYPES)[number];
export type EventType = (typeof EVENT_TYPES)[number];

const daemonOnly: ReadonlySet<string> = new Set(DAEMON_EVENT_TYPES);
export const isDaemonOnly = (t: EventType): boolean => daemonOnly.has(t);

/**
 * ion's own question when a chat's agent hit its limit (need.raised's `limit`): the agent (from), the one offered (to,
 * null: none is free), and which agent "Wait" goes on with, at what time; `request`: what Auto's judge weighs on the
 * run that goes on (the request the limited run was given).
 */
const HandoffLimitSchema = z.strictObject({
  from: z.string().min(1),
  to: z.string().min(1).nullable(),
  waitOn: z.string().min(1),
  until: z.iso.datetime(),
  /** `until` is ion's guess (the limit didn't say): at that time ion tries, and waits again if still limited. */
  guessed: z.literal(true).optional(),
  /** `to` is limited by a guess only: it may be free again (trying it tells). */
  maybe: z.literal(true).optional(),
  request: z.string().optional(),
});
export type HandoffLimit = z.infer<typeof HandoffLimitSchema>;

export const RUN_END_STATUSES = ["done", "failed", "interrupted", "capped"] as const;
export type RunEndStatus = (typeof RUN_END_STATUSES)[number];

/** How loud a notification is: Urgent and Needs you as they come, Updates by the project's level, Summary after quiet hours. */
export const NOTIFY_KINDS = ["urgent", "needs", "update", "summary"] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/** Data schemas for types whose payload the daemon relies on. Other types accept any object. */
export const TOOL_KINDS = ["read", "edit", "command", "search", "web", "mcp", "other"] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];
export const DECISIONS = ["allow", "allow_always", "deny"] as const;
export type Decision = (typeof DECISIONS)[number];

/** How far an answer reaches: this chat, this project, or every project. */
export const DECISION_SCOPES = ["chat", "project", "everywhere"] as const;

const text = z.object({ text: z.string() });
const count = z.number().int().min(0);
/** One line ion says in a chat. */
const line = z.string().min(1).max(200);

export type { IonCard } from "./ion-cards.js";

export const dataSchemas: Partial<Record<EventType, z.ZodType>> = {
  "chat.created": z.object({
    title: z.string(),
    projectId: z.string().nullable(),
    worktree: z.string().nullable().optional(),
    branch: z.string().nullable().optional(),
    /** A thread ion started (Plan 09): its questions go through the project's ion. Your own chats have none. */
    by: z.literal("ion").optional(),
  }),
  /** Your message to an ion, on its chat ("ion:<ionId>"). */
  /** Your message to an ion, with what you picked with "/" and "@" (shown as chips). */
  "ion.heard": z.object({ text: z.string(), ...PICKED }),
  /** What an ion says in its chat, with a card when it has one. */
  "ion.said": z.object({ text: z.string(), card: IonCardSchema.optional() }),
  /**
   * The agent session an ion thinks in, kept between its turns (resumed while its agent stays the same); both null:
   * forgotten (a turn on it failed), so its next turn starts fresh. `projects`: the projects its tools could see
   * (sorted ids); when they change, its next turn starts fresh.
   */
  "ion.session": z
    .object({
      ionId: z.string().min(1),
      harness: z.string().min(1).nullable(),
      nativeId: z.string().min(1).nullable(),
      projects: z.array(z.string()).optional(),
    })
    .refine((d) => (d.harness === null) === (d.nativeId === null), {
      message: "A session has both its agent and its id, or neither (forgotten)",
    }),
  /** Your answer to an ion's suggestion: taken (keep), not now, or not now and fewer like this (mute). */
  "suggestion.answered": z
    .object({ suggestionId: z.string(), keep: z.boolean(), mute: z.literal(true).optional() })
    .refine((d) => !(d.keep && d.mute), { message: "A suggestion you took isn't muted" }),
  /** You renamed the chat. */
  "chat.renamed": z.object({ title: z.string().min(1) }),
  /** What you asked: the text of an ask, stored before its run is queued. */
  "message.sent": z.object({
    text: z.string(),
    /** What the chat shows as yours, when `text` is ion's wording for the agent (your answer to its question). */
    shown: z.string().optional(),
    /** The question (its needId) this message answers: the chat shows it as your reply, where you sent it. */
    answers: z.string().optional(),
    /** What you picked with "/" and "@" (shown as chips; the agent got them its way). */
    ...PICKED,
    /** ion's brief handing the chat to another agent, or back after a limit: the chat shows its one line instead. */
    handoff: z.literal(true).optional(),
  }),
  /** A memory file made or changed, or a note from before memory was files; and one forgotten. */
  ...memoryEventSchemas,
  "need.raised": z.object({
    needId: z.string(),
    requestId: z.string(),
    kind: z.string(),
    summary: z.string(),
    detail: z.string().nullable(),
    dedupeKey: z.string(),
    /** ion's own question about a tool call it stopped (the call waits for the answer, up to 4 minutes). */
    blocked: z.boolean().optional(),
    /** In an ion thread: the project's ion's one line of context for you. */
    via: z.object({ note: z.string() }).optional(),
    /** In an ion thread: the same question is already waiting (this need), so this one isn't shown; it's settled
     * by that answer, or raised if that one closes another way. */
    heldFor: z.string().optional(),
    /**
     * ion's own question when a chat's agent hit its limit: the agent (from), the one offered (to, null: none is
     * free), and which agent "Wait" goes on with, at what time.
     */
    limit: HandoffLimitSchema.optional(),
    /** An agent's question (kind "ask"): its choices, each with what it leads to (ion's limit question: Wait alone). */
    choices: z
      .array(
        z.object({
          label: z.string().min(1).max(200),
          /** What it leads to: reasoning, tradeoffs, and what the user needs to know to decide. */
          consequence: z.string().max(1000),
          /** The agent's own pick (at most one). */
          recommended: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(4)
      .optional(),
  }),
  "need.resolved": z.object({
    needId: z.string(),
    /** allow/deny: an old permission need. answered: a question, with the choice you picked. */
    decision: z.enum([...DECISIONS, "superseded", "answered"]),
    by: z.enum(["you", "ion", "daemon"]),
    choice: z.string().optional(),
    scope: z.enum(DECISION_SCOPES).optional(),
    /** superseded: why it closed without you (its run stopped, the chat was archived, ion restarted, asked again). */
    why: z.enum(["stopped", "archived", "restarted", "asked again"]).optional(),
  }),
  /** Your answer kept for later: this chat only, this project, or everywhere. by ion: answered from fromDecision. */
  "decision.recorded": z.object({
    decisionId: z.string(),
    needId: z.string(),
    projectId: z.string(),
    question: z.string(),
    choice: z.string(),
    scope: z.enum(DECISION_SCOPES),
    by: z.enum(["you", "ion"]),
    fromDecision: z.string().optional(),
    /** The choice is your own words, not one of the agent's choices. */
    custom: z.boolean().optional(),
    /** An answer about a tool call ion stopped (not an agent's question). */
    blocked: z.boolean().optional(),
    /** "Always allow": the hash of the exact action (tool and input) that may run without asking. */
    allowKey: z.string().optional(),
    /** When you made fromDecision, for the chat line. */
    fromDecidedAt: z.string().optional(),
  }),
  /** What happened after a decision: the follow-up run ran or failed, or a note from the agent or you. */
  "decision.outcome": z.object({
    decisionId: z.string(),
    kind: z.enum(["ran", "failed", "note"]),
    text: z.string().max(2000),
    by: z.enum(["ion", "agent", "you"]),
  }),
  "decision.forgotten": z.object({ decisionId: z.string() }),
  /**
   * A message you queued while a chat's agent or an ion works (on that chat's or ion's own events): it goes out when
   * the work ends, with the brain (agent, model, effort, access) you picked when you queued it.
   */
  "queue.added": z.object({
    queueId: z.string().min(1),
    to: z.union([z.object({ chatId: z.string().min(1) }), z.object({ ionId: z.string().min(1) })]),
    text: z.string().min(1),
    brain: z.object({
      harness: z.string().optional(),
      model: z.string().optional(),
      effort: z.enum(["low", "medium", "high", "max"]).optional(),
      access: z.enum(["auto", "full"]).optional(),
      ...PICKED,
    }),
  }),
  /** You took it out of the queue (removed, or back in the box to edit), or its chat was archived. */
  "queue.removed": z.object({ queueId: z.string().min(1) }),
  /** It went out: as the chat's next message, or to the ion. */
  "queue.sent": z.object({ queueId: z.string().min(1) }),
  /**
   * It couldn't go out (the agent signed out…): it waits, saying why, and holds the queue until things move (Send
   * now, Edit or Remove in that queue, or a run there that goes well); `why` null: no longer held.
   */
  "queue.failed": z.object({ queueId: z.string().min(1), why: z.string().min(1).nullable() }),
  /**
   * A routine's time came (by "schedule", for the slot `due`) or you ran it now (by "you", due null): the thread it
   * started, why it couldn't start, or that you skipped this one. One per slot: missed slots run once, as the last.
   */
  "routine.ran": z.object({
    projectId: z.string(),
    routineId: z.string(),
    name: z.string(),
    due: z.iso.datetime().nullable(),
    by: z.enum(["schedule", "you"]),
    chatId: z.string().optional(),
    why: z.string().optional(),
    skipped: z.literal(true).optional(),
  }),
  /**
   * A system notification (on the "notify" stream): the project's name (or "ion"), what it's about in a line, and
   * the chat it opens. Held through quiet hours; then one "summary" for what was held.
   */
  notify: z.object({
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(400),
    chatId: z.string().min(1).optional(),
    kind: z.enum(NOTIFY_KINDS),
  }),
  /** ion chief's daily briefing went out for this local day (YYYY-MM-DD): never twice, also across a restart. */
  "briefing.posted": z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  /** A to-do's one reminder on its due morning (in ion chief's briefing or its own line): never twice. */
  "todo.reminded": z.strictObject({
    path: z.string().min(1).max(200),
    due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  /** A connection (its name in mcp.json) signed in, signed out, or needs signing in again: never a token. */
  "tool.signedIn": z.strictObject({ id: z.string().min(1).max(40) }),
  "tool.signedOut": z.strictObject({ id: z.string().min(1).max(40) }),
  "tool.needsSignIn": z.strictObject({ id: z.string().min(1).max(40) }),
  /** A chat's run went without one of your MCP servers, and why, in a plain line (its name only, never a value). */
  "tool.skipped": z.strictObject({ id: z.string().min(1).max(40), text: z.string().min(1).max(200) }),
  /** A chat's agent added a connection, skill or hook with ion's commands: it's off until you turn it on. */
  "tool.added": z.strictObject({ kind: z.enum(["mcp", "skill", "hook"]), name: z.string().min(1).max(80) }),
  /**
   * One of your hooks ran (on the "hooks" stream): exit code (null: stopped, at its time limit or because it
   * couldn't start), how long, and the end of its output (keys masked).
   */
  "hook.ran": z.strictObject({
    hookId: z.string().min(1).max(64),
    ok: z.boolean(),
    code: z.number().int().nullable(),
    ms: z.number().int().min(0),
    tail: z.string().max(2000),
  }),
  /**
   * A chat's agent hit its limit, or a long chat started a new session, or Pick by usage picked its agent: one line
   * in the chat ("Continued on Codex — Claude hit its limit", "Waits for Claude — 16:00", "Started fresh with a
   * summary", "On Codex — Claude Code is near its limit"). `to`: the agent it goes on with; `until`: when a wait ends.
   */
  "chat.handoff": z.strictObject({
    /** failed: a wait couldn't go on; stopped: you stopped a wait (neither is taken up again). */
    kind: z.enum(["continued", "waiting", "fresh", "routed", "failed", "stopped"]),
    text: z.string().min(1).max(200),
    to: z.string().min(1).optional(),
    until: z.iso.datetime().optional(),
    /** A wait whose reset is ion's guess: at `until` ion tries, and waits again while still limited. */
    guessed: z.literal(true).optional(),
    /** How many times a guessed wait has tried so far (kept across a restart). */
    tries: z.number().int().min(0).optional(),
    /** A wait's: what Auto's judge weighs on the run that goes on (the limited run's request). */
    request: z.string().optional(),
  }),
  /**
   * A run waiting for a slot, with its access (a handoff on another agent keeps the chat's). `waiting`: a chat ion
   * started waits for one of its slots, and says why ("Waiting — 4 ion chats running").
   */
  "run.queued": z.object({
    access: z.enum(["auto", "full"]).optional(),
    waiting: line.optional(),
    /** The agent the run will use (the chat shows it while the run waits). */
    harness: z.string().min(1).optional(),
  }),
  "run.retrying": z.object({
    attempt: z.number().int().min(1),
    delayS: z.number().min(0),
    reason: z.string(),
    effort: z.string().nullable(),
  }),
  "run.started": z.object({
    harness: z.string(),
    model: z.string(),
    effort: z.string().nullable(),
    authMethod: z.string().nullable(),
    /** The harness's own session id, to continue the chat later. */
    sessionId: z.string().nullable().optional(),
  }),
  "message.delta": text,
  "message.completed": text,
  "thinking.delta": text,
  "tool.started": z.object({
    toolId: z.string(),
    name: z.string(),
    kind: z.enum(TOOL_KINDS),
    summary: z.string(),
    /** The tool's input (text or indented JSON), cut to 8 KB. */
    input: z.string().max(9000).optional(),
  }),
  "tool.output": z.object({ toolId: z.string(), text: z.string() }),
  "tool.finished": z.object({
    toolId: z.string(),
    ok: z.boolean(),
    /** What the step did, when the harness only knew it after the step started (it replaces the start's). */
    summary: z.string().nullable(),
    /** The input, when the harness only gave it after the tool started. */
    input: z.string().max(9000).optional(),
  }),
  "file.changed": z.object({
    path: z.string(),
    change: z.enum(["add", "modify", "delete"]),
    added: count.nullable(),
    removed: count.nullable(),
  }),
  "approval.requested": z.object({
    requestId: z.string(),
    toolId: z.string(),
    kind: z.string(),
    summary: z.string(),
  }),
  "approval.resolved": z.object({
    requestId: z.string(),
    decision: z.enum(DECISIONS),
    /**
     * you (a need you answered), policy (inside the worktree), ion (Auto decided), full (Full access),
     * gate (the harness's own prompt for a call ion's gate had already allowed), hook (one of your "Before a tool
     * runs" hooks said no).
     */
    by: z.enum(["you", "policy", "ion", "full", "gate", "hook"]),
    reason: z.string().optional(),
    /** What was asked, for a decision made at the gate (no approval.requested comes before it). */
    summary: z.string().optional(),
    /** What Auto's judge said when it didn't allow the call: no, or that it wasn't sure (missing information). */
    judge: z.enum(["deny", "unsure"]).optional(),
  }),
  ...usageEventSchemas,
  "run.finished": z.object({
    status: z.enum(RUN_END_STATUSES),
    /** An ion's turn or the judge's session (kept off any chat): its agent and when it started (views/usage.ts). */
    harness: z.string().optional(),
    startedAt: z.iso.datetime().optional(),
  }),
  error: z.object({
    code: z.string(),
    retryable: z.boolean(),
    message: z.string(),
    /** Seconds the harness asked us to wait before trying again (rate limits). */
    retryAfterS: z.number().min(0).optional(),
    /** The agent's usage limit: it won't go on until it resets (when it said when). */
    limit: z.object({ resetsAt: z.iso.datetime().optional() }).optional(),
    /** The agent, for a limit hit outside a chat's run (an ion's turn, the judge): ion stamps it. */
    harness: z.string().optional(),
  }),
};

const Envelope = z.object({
  v: z.literal(SCHEMA_VERSION),
  id: z.string().min(1),
  chatId: z.string().min(1).nullable(),
  runId: z.string().min(1).nullable(),
  seq: z.number().int().min(1),
  ts: z.iso.datetime(),
  origin: z.enum(["adapter", "daemon"]),
  native: z.object({ harness: z.string(), type: z.string(), ref: z.string() }).optional(),
  type: z.enum(EVENT_TYPES),
  data: z.record(z.string(), z.unknown()),
});

export const EventSchema = Envelope.superRefine((e, ctx) => {
  // Trust boundary: adapters translate CLI output; only the daemon may decide needs, approvals, routing.
  if (e.origin === "adapter" && daemonOnly.has(e.type)) {
    ctx.addIssue({
      code: "custom",
      path: ["type"],
      message: `adapter may not emit daemon-only event ${e.type}`,
    });
  }
  const schema = dataSchemas[e.type];
  if (!schema) return;
  const r = schema.safeParse(e.data);
  // Each of its issues, under data.
  for (const issue of r.success ? [] : r.error.issues)
    ctx.addIssue({ ...issue, path: ["data", ...issue.path] } as never);
});

export type IonEvent<T extends EventType = EventType> = Omit<z.infer<typeof Envelope>, "type"> & { type: T };
export type NewEvent = Omit<IonEvent, "v" | "id" | "seq" | "ts">;

/** Validates an unknown value as an IonEvent. Throws a ZodError when invalid. */
export function parseEvent(x: unknown): IonEvent {
  return EventSchema.parse(x) as IonEvent;
}
