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
export const dataSchemas: Partial<Record<EventType, z.ZodType>> = {
  "chat.created": z.object({ title: z.string(), projectId: z.string().nullable() }),
  "run.started": z.object({ harness: z.string(), model: z.string(), effort: z.string().nullable() }),
  "run.finished": z.object({ status: z.enum(RUN_END_STATUSES) }),
  error: z.object({ code: z.string(), retryable: z.boolean(), message: z.string() }),
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
