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
