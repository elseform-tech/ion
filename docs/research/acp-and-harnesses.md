# ACP and the harnesses ion drives (checked 2026-11-17)

ion talks to Claude Code through the Claude Agent SDK, to Codex through its app-server, and to most other coding
agents through the
**Agent Client Protocol (ACP)**: JSON-RPC 2.0 over the agent's stdin/stdout, one JSON message per line.
Spec: https://agentclientprotocol.com (v1 pages under `/protocol/v1/`). TypeScript SDK: `@agentclientprotocol/sdk` 2.7.0
(the 2.x API replaced `ClientSideConnection`; ion uses its own small client for the five methods it needs).

## What ion uses

| Step | Message | Notes |
|---|---|---|
| Start | `initialize { protocolVersion: 1, clientCapabilities: {} }` | No fs/terminal capabilities: agents use their own. Result may list `authMethods`. |
| Session | `session/new { cwd, mcpServers: [] }` → `{ sessionId, configOptions? }` | Error `-32000` = sign-in needed. |
| Model | `session/set_config_option { sessionId, configId, value }` (option with `category: "model"`) | Older agents: `session/set_model`. |
| Turn | `session/prompt { sessionId, prompt: [{ type: "text", text }] }` → `{ stopReason }` | `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`. |
| Stop | `session/cancel { sessionId }` (notification) | Answer any open permission request with `{ outcome: { outcome: "cancelled" } }`. |
| Stream | `session/update { sessionId, update: { sessionUpdate, … } }` | `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage_update { used, size, cost? }`; ignore unknown kinds. |
| Permission | `session/request_permission { toolCall, options: [{ optionId, name, kind }] }` | `kind`: `allow_once`, `allow_always`, `reject_once`, `reject_always`. Reply `{ outcome: { outcome: "selected", optionId } }`. |

Tool call fields: `toolCallId`, `title`, `kind` (`read, edit, delete, move, search, execute, think, fetch, switch_mode, other`),
`status` (`pending, in_progress, completed, failed`), `content[]` (`content`, `diff { path, oldText?, newText }`, `terminal`), `locations[]`.

## Harnesses

| Harness | Launch | Sign-in check | Notes |
|---|---|---|---|
| Claude Code | Claude Agent SDK (`query()`), user's `claude` binary | `claude auth status --json` → `loggedIn`, `authMethod` | ion requires the Claude login (`claude.ai` / `oauth_token`) and strips `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`. |
| Grok Build | `grok agent stdio` | No status command; probe with `session/new` (`-32000` = signed out). Login: `grok login` | ACP is its native format. Models: `grok models`. |
| opencode | `opencode acp` | Probe; `opencode auth list` lists saved accounts | Free models `opencode/*-free` (limited-time); the default for ion's live tests. |
| Cursor CLI | `cursor-agent acp` | `cursor-agent status` | Later plan. |
| Gemini CLI | `gemini --acp` | Probe | Later plan; may need `session/set_model`. |
| Codex | `codex app-server` (JSON-RPC on stdio, Codex's own protocol; not ACP) | `codex login status`: exit code 0 = signed in | See "Codex" below. |

## Quota policy for ion's own testing

CI never calls a model. Live tests are opt-in: `ION_LIVE=1` uses opencode with a free model; `ION_LIVE_GROK=1` adds Grok Build;
`ION_LIVE_CLAUDE=1` adds Claude Code (Haiku), only when the Claude adapter itself changed. `ION_LIVE_CODEX=1` adds
Codex (your ChatGPT plan's quota; `ION_CODEX_MODEL` picks a model, its smallest is enough).

The live evals (`apps/daemon/src/evals/live.test.ts`) run ion's promises end to end through the daemon on each
agent you opt in, and print a table: the agent asks through ion and follows your answer, with no hidden tool
errors; it edits a file in its worktree (your checkout untouched); ion chief answers and routes one message.
Run them before a PR that touches an adapter, questions, the gate or ion's own model:
`ION_LIVE=1 [ION_LIVE_GROK=1] [ION_LIVE_CLAUDE=1] [ION_LIVE_CODEX=1] pnpm --filter @ion/daemon exec vitest run src/evals`.

### Agents' own question tools (found 2026-11-18)

Each agent has its own way to ask the user, and none works headless under ion:
- Claude's `AskUserQuestion`: answers itself empty in the SDK. Off (`disallowedTools`) when ion's MCP is there.
- Grok's `ask_user_question`: calls an ACP extension method on the client; ion has none, so it failed with
  "Method not found". Off with `GROK_ASK_USER_QUESTION=false` (its `features.ask_user_question`).
- opencode: none seen; it used ion's `ask` from the tool's description alone.
- Codex: `request_user_input` (`item/tool/requestUserInput`) exists only in Plan mode; ion turns it off in the
  default mode too (`features.default_mode_request_user_input=false`) and answers the request with an error that
  points at ion's `ask` tool. It asked through ion's `ask` in the live evals.

Without being told, Claude and Grok wrote a question as reply text and ended the run (nothing to answer), so ion
tells every run to ask through its `ask` tool (`apps/daemon/src/runs/instructions.ts`).

## Sessions, MCP and models (probed 2026-11-17, Plan 04)

| | Grok Build | opencode |
|---|---|---|
| `agentCapabilities` | `loadSession`, `sessionCapabilities.resume/list/close`, `mcpCapabilities.http/sse` | `loadSession`, `sessionCapabilities.resume/fork/list/close`, `mcpCapabilities.http/sse` |
| Models | `session/new` → `models.availableModels` and a `model` config option (`grok-4.7`, `grok-4.7-build-fast`, `grok-4.6`, `grok-4.5`); `reasoning_effort` option (`xhigh/high/medium/low`) | `model` config option (`opencode/big-pickle` default, `opencode-go/*`), `mode` option (`build/plan`) |
| MCP tool permission | Asks: `toolCall.kind: "other"`, `title: "ion__search_chats"`, `rawInput: { variant: "UseTool", tool_name: "<server>__<tool>", tool_input }` | Doesn't ask (MCP tools run without `session/request_permission`); tools show as `ion_<tool>` |
| Built-in auto-approvals | Read-only commands (`cat`, `ls`, `grep`, `git log`…) plus `touch`/`mkdir`, in every mode | — |

Claude Code: `query({ options: { resume, mcpServers: { ion: { type: "http", url, headers } } } })`; MCP tools are `mcp__<server>__<tool>` and go through `canUseTool`. `claude -p --resume <unknown id>` prints `No conversation found with session ID: …` and exits before any model call; ion checks `getSessionMessages(id, { dir })` first. `supportedModels()` gives `{ value, displayName, … }`.

## Grok's own auto-approvals (probed 2026-11-18, Plan 05)

Grok runs its built-in read-only commands (`cat`, `ls`, `grep`, `git log`…, plus `touch`/`mkdir`) without
`session/request_permission`, in every mode. None of these stopped `cat` of a protected file in `grok agent stdio`:
`GROK_CONFIG` `permission.ask` (not overlay-allowlisted; only `shell_environment_policy.*`, `toolset.*` are),
`--deny "Read(<path>)"` (with `/` or `//`), `--deny "Bash(*<path>*)"`. ACP agents also stream text only
(`agent_message_chunk`); ion's ACP adapter now sends `message.completed` when a message ends.

**Fixed in Plan 06 with hooks (probed 2026-11-18).** A Grok `PreToolUse` hook fires for every tool call,
built-in read-only commands included, under `grok agent stdio`, and its deny stops the call.
- **Hooks in the chat's worktree** (`.grok/hooks/`) load only with `GROK_FOLDER_TRUST=0`, which would also load a
  repo's own Grok hooks, MCP and LSP servers unasked, so ion doesn't use them.
- **A global hook in `~/.grok/hooks/`** fires in ion's runs (an untrusted worktree, `agent stdio`). ion uses one
  that does nothing without `ION_GATE_URL`. Cost: with any hook of your own, Grok asks for folder trust in every
  folder you use it in yourself.
- **The hook payload** is `{toolName, toolInput, toolInputTruncated, …}` (camelCase, with snake_case copies).
  `http` hooks expand `${ION_GATE_URL}` from the environment. `failClosed: true` makes a failed hook deny.
- **opencode:** a plugin listed in `OPENCODE_CONFIG_CONTENT` (`plugin: ["file://…"]`) gets
  `tool.execute.before(input, output)` with `input.tool` and `output.args` for every tool, MCP tools included
  (named `<server>_<tool>`). Throwing blocks the call.
- **Claude Code:** the Agent SDK's `hooks.PreToolUse` callbacks run in-process. ion passes one when the run has a
  gate.

## Codex (probed 2026-11-19, codex-cli 0.153.2)

**Mode: `codex app-server`.** Codex has no `acp` subcommand and no ACP flag. ACP needs Zed's bridge
(`@zed-industries/codex-acp` on npm, not installed here): a separate install that embeds its own Codex core, so
it lags the user's `codex`, and it maps only part of Codex (approvals, hooks, models) onto ACP. `codex app-server`
ships with the CLI and is Codex's own JSON-RPC protocol over stdio (the VS Code extension and the Codex app use
it; still marked experimental). It has threads, turns, item events, approvals asked over the protocol, model and
account methods, and `thread/resume`. `codex exec --json` streams events but can't ask anyone before a tool runs
(`never` approvals only) and resumes only by starting a new process, so it can't put ion in the loop.
`codex mcp-server` makes Codex an MCP tool: one call per turn, approvals as MCP elicitations, no item stream.
Types: `codex app-server generate-ts --out <dir>`.

| Step | Message | Notes |
|---|---|---|
| Start | `initialize { clientInfo, capabilities: null }`, then the `initialized` notification | Lines of JSON; Codex's messages have no `jsonrpc` field (it accepts one). |
| Sign-in | `account/read` → `{ account: null \| { type: "chatgpt" \| "apiKey" … }, requiresOpenaiAuth }` | `account` holds the email: ion reads `type` only. `codex login status` prints `Logged in using ChatGPT` / `Not logged in` and exits 1 when signed out. |
| Models | `model/list { includeHidden: false }` → `data[{ id, displayName, hidden, isDefault, supportedReasoningEfforts }]` | Efforts `low` … `xhigh`, `max`, `ultra` (per model); ion's `max` is `xhigh`. |
| Thread | `thread/start { cwd, model?, approvalPolicy, approvalsReviewer, sandbox, config, developerInstructions }` → `{ thread: { id }, model }` | `config` is any config.toml override for this thread. |
| Resume | `thread/resume { threadId, …same, excludeTurns: true }` | Unknown id: error `-32600` "no rollout found"; not a UUID: `-32600` "invalid session id". |
| Turn | `turn/start { threadId, input: [{ type: "text", text, text_elements: [] }], effort? }` → `{ turn: { id } }` | Ends with `turn/completed { turn: { status: completed \| interrupted \| failed, error } }`. |
| Stop | `turn/interrupt { threadId, turnId }` | The turn completes as `interrupted`. |
| Stream | `item/started`, `item/completed` (`agentMessage`, `reasoning`, `commandExecution`, `fileChange`, `mcpToolCall`, `webSearch` …), `item/agentMessage/delta`, `item/reasoning/summaryTextDelta`, `thread/tokenUsage/updated { tokenUsage: { last, total } }`, `error { error, willRetry }` | A command item's `command` is `/bin/zsh -lc '<command>'`; `aggregatedOutput`, `exitCode`. A file change has `changes[{ path, kind, diff }]`. |
| Approvals | `item/commandExecution/requestApproval` → `{ decision: accept \| acceptForSession \| decline \| cancel }`; `item/fileChange/requestApproval` (same; the files are in the item that started just before); an MCP tool: `mcpServer/elicitation/request` with `_meta.codex_approval_kind: "mcp_tool_call"` → `{ action: accept \| decline, content: null, _meta: null }` | With `approvalPolicy: "untrusted"` every command asked, even `cat`, and every edit; `approvalsReviewer: "user"` sends them to ion, not Codex's auto-reviewer. |

**MCP.** `thread/start`'s `config.mcp_servers.ion = { url, http_headers: { Authorization: "Bearer …" } }` works
(the header reached the server). It goes over stdin, so the key never shows in `ps`. MCP tools show as
`mcp__<server>__<tool>`; your own Codex MCP servers load too.

**The gate: a `PreToolUse` hook passed with `-c`.** Hooks are stable in this version and fire for every tool:
`Bash`, `apply_patch` (its input is the patch: `{ command: "*** Begin Patch …" }`) and MCP tools
(`mcp__ion__search_chats`). The payload is Claude Code's shape (`tool_name`, `tool_input`, `cwd`, `session_id`,
`hook_event_name`…), and `{ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason } }` on stdout
stops the call before its item even starts. Codex runs a hook only once its exact content is trusted:
- `-c 'hooks.PreToolUse=[{matcher="*",hooks=[{type="command",command="…",timeout=300}]}]'` adds the hook for that
  process only (`source: "sessionFlags"`, key `/<session-flags>/config.toml:pre_tool_use:0:0`), `untrusted`.
- `-c 'hooks.state={"<key>"={trusted_hash="sha256:…"}}'` (an inline table; the dotted form didn't take) trusts it.
  The hash is Codex's (`hooks/list` → `currentHash`), so ion starts Codex once to learn it, then again trusting it,
  and keeps it while the daemon runs. Nothing is written to your Codex folder. `-c bypass_hook_trust=true` didn't
  change the status.
- A repo's own hooks stay untrusted (they need your trust by hash), unlike Grok's folder-trust trade-off.
- With any hook in a session, Codex's background **memory** agent also ran tools through it (cwd `~/.codex/memories`).
  ion turns memories off for its runs (`features.memories=false`); ion has its own memory.

The approval that follows a gate allow is matched by command (unwrapped from the shell) or by file, as for Grok.
