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
`decision.recorded`, `decision.outcome`, `decision.forgotten`, `queue.added`, `queue.removed`, `queue.sent`,
`queue.failed`, `notify`, `briefing.posted`, `tool.signedIn`, `tool.signedOut`, `tool.needsSignIn`,
`memory.dreamed`, `todo.reminded`, `chat.handoff`, `chat.memory`.

Usage and limits (Plan 20): `usage.reported` carries `inputTokens`, `outputTokens`, `totalTokens` (every token the run
processed, cached context too; absent when the agent's count is partial, as opencode's over ACP), `costUsd`, and
`windows` (`{ name, usedPercent, resetsAt }`, the agent's own rate-limit windows; absent when it reports none, so a
gauge it stopped reporting goes away). An `error` from an agent at its usage limit carries `limit { resetsAt? }`.
Usage and limits of ion's own sessions (ions' turns, the judge) are stored with `chatId` null and `harness` in the
data. `chat.handoff` is one line in a chat: `kind` `continued` ("Continued on Grok Build — Claude Code hit its
limit", `to` the agent that went on), `waiting` ("Waits for Codex — 16:00", `until`, `guessed` when the reset was
ion's guess, `tries`), `fresh` ("Started fresh with a summary") or `routed` (Automatic's reason, "On opencode —
free and enough for this"). The message that hands a chat to another agent is `message.sent` with `handoff: true`
(ion's brief; the chat shows the line instead). `run.queued` carries the agent the run will use (`harness`) and may
carry `waiting` ("Waiting — 4 ion chats running"): a chat ion started waits for one of its slots. A chat waiting for
a slot or for its agent's reset reads as waiting (`ChatInfo.waiting`), not failed. ion's limit question is a `need.raised` that carries the `limit` it
offers (from, to, until); your "Always continue on X here" is a `decision.recorded` keyed `handoff:<agent>`.

A memory file's change is `memory.written` (its path, scope, header, hash, `by`, and the text `before`) or
`memory.forgotten` (`path`, `by`, `before`, and `into`: the file ion's dream merged it into). A header's `suggested`
marks a file waiting for your Keep: a project's id (a chat's preference: that project's chats, its ion and ion chief
see it), or `_` and an ion's id (a file an ion wrote that chats would see: only the ions see it). ion's dream
records each night as `memory.dreamed` (chatId null): `status` `started`, then `done`, `late` or `failed`, with what
it merged, updated, forgot and moved, its notes, and the night (`period`). `todo.reminded { path, due }` (chatId
null) is a to-do's one reminder for its due day.

Memory can be off (the user, 2026-11-23): `memory.on` in config.toml (everywhere; your own files follow it) and a
project's `memory` (absent: as everywhere). `chat.memory { on }` is "Don't remember" (false) or "Remember" (true) from a
chat's menu, or `ask`'s `noMemory` (`ion ask --no-memory`); `ChatInfo.notRemembered` says so. Where memory is off, a
chat's agent or an ion gets no memory tools, no index and no word of memory in its instructions, writes nothing, is
offered no "Mark done?", and ion's dream skips it; the files stay, yours to read and change, and reminders of your
to-dos still come.

Signing in to a remote MCP server (OAuth) is `tool.signedIn { id }`, `tool.signedOut { id }` and
`tool.needsSignIn { id }` (a refresh failed: "Sign in again"), `id` being the server's name in mcp.json. They never
carry a token: tokens live only in the keychain.

A system notification is a `notify` event on the `notify` stream (chatId `"notify"`): `title` (the project's name,
or "ion"), `body` (a line), the `chatId` it opens, and `kind`: `urgent` (a call ion stopped, a run that gave up),
`needs` (any other question), `update` (a run that finished), or `summary` (one, when quiet hours end, for what they
held). Which kinds notify is the project's `notify` level. ion chief's daily briefing is an `ion.said` in its chat;
`briefing.posted { day }` (local `YYYY-MM-DD`) keeps it to once a day.

A queued message (your next message to a chat or an ion while it works) is its events on the chat's stream (an
ion's: `ion:<ionId>`): `queue.added` (its text and brain), then `queue.sent`, or `queue.removed` (removed, edited,
its chat archived). `queue.failed` says why it waits (`why`; `"Stopped"` after you stopped the work), and with
`why: null` that it goes on.

A `routine.ran` (chatId null) is one slot of a routine handled: the thread it started, why it couldn't, or that
you skipped it; `by: "you"` with `due: null` is a run you started now.

An ion's chat is its events on `ion:<ionId>`: `ion.heard` (your message) and `ion.said` (its words, with an
optional `card`). Each turn an ion thinks is an agent session: its `tool.started`, `tool.finished` and
`thinking.delta` are stored on its chat with the turn's id as `runId`, and `ion.session` (`ionId`, `harness`,
`nativeId`) records the session it resumes next time. Card kinds: `threads` (the threads it started), `suggest` (a project ion's "always?"), `flag` (a
decision whose runs keep failing), and ion chief's own suggestions (Plan 11): `routine` (`projectId`, `key`: your
words normalised, `name`, `text`, `when`, `dates`: the days you asked) and `stalled` (`chatId`, `projectId`,
`title`, `since`: the chat's last activity, `files` changed). `suggestion.answered` is your answer to any of them:
`keep` (take it: add the routine, resume the chat), or not, with `mute: true` for "fewer like this" (no more of
that kind for that project). ion chief's suggestions live on `ion:chief`; the commands are `suggestions.list` and
`suggestion.answer`.

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
