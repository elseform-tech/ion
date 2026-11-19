import { z } from "zod";

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
  "decision.recorded",
  "decision.outcome",
  "decision.forgotten",
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
  decisionRecorded: "decision.recorded",
  decisionOutcome: "decision.outcome",
  decisionForgotten: "decision.forgotten",
} as const satisfies Record<string, EventType>;

export type AdapterEventType = (typeof ADAPTER_EVENT_TYPES)[number];
export type DaemonEventType = (typeof DAEMON_EVENT_TYPES)[number];
export type EventType = (typeof EVENT_TYPES)[number];

const daemonOnly: ReadonlySet<string> = new Set(DAEMON_EVENT_TYPES);
export const isDaemonOnly = (t: EventType): boolean => daemonOnly.has(t);

export const RUN_END_STATUSES = ["done", "failed", "interrupted", "capped"] as const;
export type RunEndStatus = (typeof RUN_END_STATUSES)[number];

/** Data schemas for types whose payload the daemon relies on. Other types accept any object. */
export const TOOL_KINDS = ["read", "edit", "command", "search", "web", "mcp", "other"] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];
export const DECISIONS = ["allow", "allow_always", "deny"] as const;
export type Decision = (typeof DECISIONS)[number];

/** How far an answer reaches: this chat, this project, or every project. */
export const DECISION_SCOPES = ["chat", "project", "everywhere"] as const;

const text = z.object({ text: z.string() });
const count = z.number().int().min(0);

/** What an ion's message can carry: threads it started, a suggestion, or a decision that keeps failing. */
const IonCardSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("threads"),
    threads: z.array(z.object({ chatId: z.string(), projectId: z.string() })),
  }),
  z.object({
    kind: z.literal("suggest"),
    suggestionId: z.string(),
    question: z.string(),
    choice: z.string(),
  }),
  z.object({
    kind: z.literal("flag"),
    decisionId: z.string(),
    question: z.string(),
    choice: z.string(),
    failed: z.number().int().min(1),
  }),
]);
export type IonCard = z.infer<typeof IonCardSchema>;

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
  "ion.heard": z.object({ text: z.string() }),
  /** What an ion says in its chat, with a card when it has one. */
  "ion.said": z.object({ text: z.string(), card: IonCardSchema.optional() }),
  /** Your answer to an ion's suggestion. */
  "suggestion.answered": z.object({ suggestionId: z.string(), keep: z.boolean() }),
  /** You renamed the chat. */
  "chat.renamed": z.object({ title: z.string().min(1) }),
  /** What you asked: the text of an ask, stored before its run is queued. */
  "message.sent": z.object({
    text: z.string(),
    /** What the chat shows as yours, when `text` is ion's wording for the agent (your answer to its question). */
    shown: z.string().optional(),
  }),
  /** Something to remember: yours ("you", shown in every project) or one project's, never shared between projects. */
  "memory.written": z.object({
    memoryId: z.string(),
    scope: z.union([z.literal("you"), z.object({ projectId: z.string() })]),
    text: z.string().min(1).max(2000),
    source: z.union([z.literal("you"), z.object({ chatId: z.string(), runId: z.string() })]),
  }),
  "memory.forgotten": z.object({ memoryId: z.string() }),
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
    /** An agent's question (kind "ask"): its choices, each with what it leads to. */
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
      .min(2)
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
  "run.queued": z.object({}),
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
     * gate (the harness's own prompt for a call ion's gate had already allowed).
     */
    by: z.enum(["you", "policy", "ion", "full", "gate"]),
    reason: z.string().optional(),
    /** What was asked, for a decision made at the gate (no approval.requested comes before it). */
    summary: z.string().optional(),
  }),
  "usage.reported": z.object({
    model: z.string(),
    inputTokens: count,
    outputTokens: count,
    costUsd: z.number().min(0).nullable(),
  }),
  "run.finished": z.object({ status: z.enum(RUN_END_STATUSES) }),
  error: z.object({
    code: z.string(),
    retryable: z.boolean(),
    message: z.string(),
    /** Seconds the harness asked us to wait before trying again (rate limits). */
    retryAfterS: z.number().min(0).optional(),
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
  if (!r.success) {
    for (const issue of r.error.issues) ctx.addIssue({ ...issue, path: ["data", ...issue.path] } as never);
  }
});

export type IonEvent<T extends EventType = EventType> = Omit<z.infer<typeof Envelope>, "type"> & { type: T };
export type NewEvent = Omit<IonEvent, "v" | "id" | "seq" | "ts">;

/** Validates an unknown value as an IonEvent. Throws a ZodError when invalid. */
export function parseEvent(x: unknown): IonEvent {
  return EventSchema.parse(x) as IonEvent;
}
