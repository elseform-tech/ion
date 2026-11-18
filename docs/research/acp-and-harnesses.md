# ACP and the harnesses ion drives (checked 2026-11-17)

ion talks to Claude Code through the Claude Agent SDK, and to most other coding agents through the
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
| Codex | `codex-acp` (`@agentclientprotocol/codex-acp`) | `codex login status` | Later plan. |

## Quota policy for ion's own testing

CI never calls a model. Live tests are opt-in: `ION_LIVE=1` uses opencode with a free model; `ION_LIVE_GROK=1` adds Grok Build;
`ION_LIVE_CLAUDE=1` adds Claude Code (Haiku), only when the Claude adapter itself changed.

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
- **Hooks in the chat's worktree** (`.grok/hooks/ion.json`) load only with `GROK_FOLDER_TRUST=0`. ion sets it for
  its own runs; untrusted, they're silently skipped.
- **A global hook in `~/.grok/hooks/`** also fires, but any global hook makes Grok ask for folder trust in every
  folder you use it in yourself, so ion doesn't use one.
- **The hook payload** is `{toolName, toolInput, toolInputTruncated, …}` (camelCase, with snake_case copies).
  `http` hooks expand `${ION_GATE_URL}` from the environment. `failClosed: true` makes a failed hook deny.
- **opencode:** a plugin listed in `OPENCODE_CONFIG_CONTENT` (`plugin: ["file://…"]`) gets
  `tool.execute.before(input, output)` with `input.tool` and `output.args` for every tool, MCP tools included
  (named `<server>_<tool>`). Throwing blocks the call.
- **Claude Code:** the Agent SDK's `hooks.PreToolUse` callbacks run in-process. ion passes one when the run has a
  gate.
