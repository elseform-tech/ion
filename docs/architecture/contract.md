# ion contract: events, adapters, walls

The design canvas (`docs/design/ion-design-lab.html`, published as "ion Design Lab" v34) is the product spec.
This file pins the parts code depends on.

## Principles

1. Commands go in, events come out. Every screen is built from events.
2. Only `apps/daemon/src/store` writes to SQLite. Everything else appends events.
3. An adapter only translates one CLI's output into ion events and ion's commands back. No routing or policy in adapters.
4. Adapters declare capabilities; the UI greys out what a harness can't do.
5. Events are append-only, versioned, and ordered per run by `seq`.
6. Config lives in files. Work, needs, routines, suggestions and memory are events.

## Event envelope (schema v1)

```ts
type IonEvent = {
  v: 1;
  id: string;            // ULID
  chatId: string | null; // null for daemon-wide events
  runId: string | null;  // null when not part of a run
  seq: number;           // per runId (or per chatId when runId is null), starts at 1
  ts: string;            // ISO 8601
  origin: "adapter" | "daemon";
  native?: { harness: string; type: string; ref: string }; // raw CLI event, stored separately
  type: EventType;
  data: unknown;         // validated per type
};
```

Adapter events: `run.started`, `run.finished` (done | failed | interrupted | capped), `message.delta`,
`message.completed`, `thinking.delta`, `tool.started`, `tool.output`, `tool.finished`, `file.changed`,
`approval.requested`, `artifact.attached`, `usage.reported`, `error` (code, retryable).

Daemon events: `chat.created`, `run.queued`, `run.waiting`, `run.retrying`, `approval.resolved`,
`need.raised`, `need.resolved`, `route.sent`, `claim.checked`, `checks.finished`, `routine.proposed`, `routine.ran`,
`briefing.written`, `signal.raised`, `proposal.made`, `proposal.answered`, `memory.written`, `memory.forgotten`,
`decision.recorded`, `decision.outcome`, `decision.forgotten`.

A `routine.ran` (chatId null) is one slot of a routine handled: the thread it started, why it couldn't, or that
you skipped it; `by: "you"` with `due: null` is a run you started now.

A `need.raised` with `kind: "ask"` is an agent's question with `choices`; its `need.resolved` has
`decision: "answered"`, the `choice` and its `scope`. Old allow/deny needs still read.

## Adapter interface

```ts
interface HarnessAdapter {
  id: "claude-code" | "codex" | "grok-build" | "gemini-cli" | "cursor-cli" | "pi" | "fake";
  detect(): Promise<{ installed: boolean; version?: string; path?: string }>;
  auth: { status(): Promise<{ signedIn: boolean }>; login(): Promise<void> }; // runs the CLI's own login
  capabilities(): Promise<Capabilities>;
  start(opts: StartOpts): Promise<Session>;
}
interface Capabilities {
  models: { id: string; label: string }[];
  effort: { levels: ("low" | "medium" | "high" | "max")[]; nativeName?: string; canDisableThinking: boolean };
  thinking: "full" | "summary" | "none";
  approvals: "interactive" | "preset-only";
  resume: boolean; interrupt: boolean; images: boolean; mcp: boolean; skills: boolean;
  usage: "tokens" | "cost" | "quota" | "none";
}
interface Session {
  id: string; nativeId: string;
  send(input: { text: string; attachments?: string[] }): Promise<void>;
  events(): AsyncIterable<IonEvent>;
  respond(requestId: string, decision: "allow" | "allow_always" | "deny", note?: string): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}
```

## Retries

Transient errors (rate limit, network, crashed CLI): exponential backoff with full jitter,
`delay = random(0, min(120s, 2s * 2^attempt))`, at most 4 tries, a rate limit's retry-after wins.
A real task failure gets one retry at the next effort level, inside the spending cap.

## Walls (enforced by lint)

| Package | May import | Never |
|---|---|---|
| `apps/desktop` | `client`, `schema`, `design-system` | `daemon`, adapters, `node:*` |
| `apps/cli` | `client`, `schema`, `config` | `daemon` internals, adapters |
| `apps/daemon` | `schema`, `config`, `policy`, `adapter-kit`, adapters via registry | `desktop`, `design-system` |
| `packages/adapters/*` | `schema`, `adapter-kit` | `daemon`, other adapters |
| `packages/policy` | `schema` | anything doing I/O |
| `packages/schema` | nothing | everything |
