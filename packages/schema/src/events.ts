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
  "briefing.written",
  "signal.raised",
  "proposal.made",
  "proposal.answered",
  "memory.written",
  "memory.forgotten",
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
  briefingWritten: "briefing.written",
  signalRaised: "signal.raised",
  proposalMade: "proposal.made",
  proposalAnswered: "proposal.answered",
  memoryWritten: "memory.written",
  memoryForgotten: "memory.forgotten",
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

const text = z.object({ text: z.string() });
const count = z.number().int().min(0);

export const dataSchemas: Partial<Record<EventType, z.ZodType>> = {
  "chat.created": z.object({
    title: z.string(),
    projectId: z.string().nullable(),
    worktree: z.string().nullable().optional(),
    branch: z.string().nullable().optional(),
  }),
  /** What you asked: the text of an ask, stored before its run is queued. */
  "message.sent": z.object({ text: z.string() }),
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
  }),
  "need.resolved": z.object({
    needId: z.string(),
    decision: z.enum([...DECISIONS, "superseded"]),
    by: z.enum(["you", "ion", "daemon"]),
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
  }),
  "tool.output": z.object({ toolId: z.string(), text: z.string() }),
  "tool.finished": z.object({ toolId: z.string(), ok: z.boolean(), summary: z.string().nullable() }),
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
    /** you (a need you answered), policy (inside the worktree), ion (Auto decided), full (Full access). */
    by: z.enum(["you", "policy", "ion", "full"]),
    reason: z.string().optional(),
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
