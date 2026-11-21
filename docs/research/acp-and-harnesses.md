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

**Security review (2026-11-19).**
- **The gate's address reached Codex's commands.** Commands inherit the app-server's environment: with
  `ION_GATE_URL` set, `printenv ION_GATE_URL` printed it, key included. `shell_environment_policy.exclude` and
  `inherit = "core"` didn't hide it (Codex's shell snapshot, a stable feature, brings it back); `exclude` with
  `features.shell_snapshot=false` did, and so does `-c 'shell_environment_policy.set.ION_GATE_URL=""'`, which ion
  uses (snapshot kept). Hooks still get the real value: the live test sees the call at the gate while the command
  prints nothing. ion's MCP key is never in the environment (it's in the thread's config, sent over stdin).
- **Network stays on** (`sandbox_workspace_write.network_access = true`), as for ion's other agents: every command
  goes through ion's gate and judge before it runs, and neither of ion's keys is readable by commands.
- **Fail closed on what ion can't tie down:** a patch with no files ion can read names no file (the policy asks;
  it used to fall back to the run's folder, which reads as an in-worktree edit); an edit approval for an item ion
  never saw start is declined; an MCP approval form, which names only the server and the tool, is asked about only
  when exactly one call to that tool is still running on that server (finished calls are forgotten), else declined.

## Ions with tools: 22 projects on Grok (2026-11-19, Plan 14)

`ION_LIVE_GROK=1 pnpm -s vitest run apps/daemon/src/evals/live.test.ts -t "22 projects"`: a real daemon, 22 git repos
with one-paragraph READMEs (`storefront` cart drawer and checkout, `payments-api` totals and webhook retries,
`mobile-app` and `admin-portal` both with login, `ledger-lab` kept from ion chief with `shareWithIon = false`, 17
more), `[ion] quick = "grok-build"`, every project on `grok-build` (grok-4.7). Judged by events: the turn's `ion.said`
(its text and threads card) and the chats ion created; threads are interrupted once started (each would spend a run).
One run, 107 s in all; all five passed.

| Check | Result | What ion chief did | Turn |
|---|---|---|---|
| "The cart drawer total is wrong" goes to storefront only | pass | `projects`, `search_chats`, `open_needs`, `memory_list`, `decisions`, then `start_thread` in storefront: "The cart drawer lives in storefront…" | 33 s (first turn: Grok's tool search first) |
| "Webhook retries…" goes to payments-api | pass | Same lookups, one thread in payments-api | 25 s |
| "What's waiting on me?" answers without a thread | pass | `open_needs`, `projects`: "Nothing is waiting on you…" | 13 s |
| "Fix the login bug." asks which, starts nothing | pass | "Is it mobile-app (email and Face ID) or admin-portal (staff SSO)? I have not started anything." | 12 s |
| A project kept from it (`ledger-lab`) is never seen or routed to | pass | "None of your projects cover nightly crypto wallet reconciliation… closest are payments-api, billing, data-warehouse. Which one?" No thread. | 22 s |

Each turn starts with the same lookups (projects, search_chats, open_needs, memory_list, often decisions), as its
instructions say; Grok runs them in parallel, so they cost about a second. Project ions (storefront,
payments-api) wrote the reports of the interrupted threads on Grok, and ion chief passed them on after its own
answer, never before.

**Real app** (`ION_HOME=/tmp/ion-live-22`, the CLI): `ion ions message chief "Have docs add one line to its README…"`
(15 s) started a thread in docs; `ion ions message mobile-app "What is this project about…"` (22 s) answered from
its README with no thread. The docs thread ran on Grok (gate and policy allowed its reads and the edit in its
worktree) and finished in 30 s. **Bug found:** docs' ion then reported "that line is not in the file": it read the
project's folder, while the thread's edit lives in its own worktree until you merge it. Fixed: a report turn is told
that a thread's changes are on its own branch, not in the project's folder, and gets the files it changed (as data).
After the fix, another docs thread was reported as "On the thread's branch, README.md now ends with… That stays on its
own branch until you merge it." No error events; `daemon.log` stayed empty.

## Only ion's tools in ion's chats (probed 2026-11-21, Plan 18 Task 9)

The user, 2026-11-21: "Only ion's, plus Import": in ion's chats every agent uses only the servers, hooks and skills
set up in ion; an agent's own stay its own, and Import (Settings → Tools, `ion mcp import`) copies servers in, off.
Each agent's switch, and how it was checked (temp `HOME`s only; nobody's real config was read):

| Agent | Its own servers | Its own hooks and plugins | Source |
|---|---|---|---|
| Claude Code | `strictMcpConfig: true` (CLI `--strict-mcp-config`): only the `mcpServers` ion passes; not `~/.claude.json`, `.mcp.json` or plugins | `settingSources: []` (no settings files, so no hooks or enabled plugins from them) | Agent SDK 0.3.326 `sdk.d.ts` (`strictMcpConfig`, `settingSources`) |
| Codex 0.153.2 | each one `config/read` (with the chat's `cwd`) lists is set `{ enabled: false }` in the thread's `config` (`mcpServerStatus/list` then says `disabled`). `-c mcp_servers={}` does nothing: config layers merge | `-c features.plugins=false`; each of your hooks `hooks/list` shows on is turned off with `-c hooks.state={"<key>"={enabled=false}}`, in the same table as the trust for ion's own hook (a second `-c hooks.state=` replaces the first). Managed hooks are left alone | `codex app-server generate-ts`; probed with a temp `CODEX_HOME` |
| opencode 1.18.8 | `XDG_CONFIG_HOME` points at an empty folder of ion's (your `~/.config/opencode` isn't read; `OPENCODE_CONFIG`/`OPENCODE_CONFIG_DIR` blanked; project config was already off). What else your config says (providers, model, agents) is carried in ion's `OPENCODE_CONFIG_CONTENT`. `~/.opencode/opencode.json` still loads: its servers are set `{ enabled: false }` by name | same folder swap drops your config's `plugin` list and `plugin/` folder; ion's gate plugin is the only one listed. `--pure` drops every plugin, ion's gate too (seen: a marker plugin didn't run), and an inline config can't take plugins away (lists add up). Gap: plugins in `~/.opencode/plugin/` still load (no switch short of moving `HOME`, which moves sign-in) | `opencode --help` (`--pure`), `opencode debug config`, `opencode debug paths`, marker plugins under a temp `HOME` |
| Grok 1.0.92 | `GROK_CLAUDE_MCPS_ENABLED=false`, `GROK_CURSOR_MCPS_ENABLED=false` (`grok inspect` then shows `[claude] [disabled]`). **No switch** for its own `~/.grok/config.toml` `[mcp_servers]` or a project's `.mcp.json`/`.grok` (after folder trust): `GROK_CONFIG` overlays only soft settings (its docs: "cannot spawn commands … or add a discovery source"; tried, still loaded), `GROK_HOME` moves its sign-in too | `GROK_CLAUDE_HOOKS_ENABLED=false`, `GROK_CURSOR_HOOKS_ENABLED=false`. **No switch** for `~/.grok/hooks/*.json` (ion's own gate hook lives there) or its enabled plugins | Grok's built-in docs (`[compat.<vendor>]`, `GROK_CONFIG`), `grok inspect` under a temp `HOME` |

So Settings → Agents shows **Also loads its own** on Grok Build and opencode (the adapter's `ownTools`; task review,
2026-11-21: opencode's `~/.opencode/plugin` and the plugins its config there lists still load, and it has no switch for
that folder short of moving `HOME`).

Task review, 2026-11-21 (opencode):
- ion's config for opencode is a **file**, never the environment: `<XDG_CACHE_HOME or ~/.cache>/ion/opencode/<short hash of ION_HOME, or `default`>/opencode/
  opencode.json` (one per ion home since the final review, 2026-11-21, so the tour, dev and the app don't race) (folder 0700, file 0600, written whole through a fresh temp file and a rename, only when it changes).
  `OPENCODE_CONFIG_CONTENT` carried your provider keys into every process opencode started (LSP servers, formatters).
  `{env:}` and `{file:}` references are kept; relative `{file:}` paths and `instructions` are made whole against your
  config folder. Only `ION_GATE_URL` is in the env.
- The folder is one of ion's own (`ionDirsOf`, so no run can read or write it). Each start checks it's yours, 0700 and
  not a link (else refuses plainly), rewrites opencode.json, removes anything else (`plugin/`, `tool/`, other config
  files, `AGENTS.md`…) and keeps only `@opencode-ai/plugin` in package.json. opencode installs that package there once
  (the first start can be slow: while it isn't there, starts take turns and a timeout says "opencode is setting up").
- What moving `XDG_CONFIG_HOME` drops for opencode in ion's chats: your global `~/.config/opencode/AGENTS.md`, its
  `agent/`, `command/`, `plugin/`, `tool/` (custom tools) and `themes/` folders, and its servers. What your config file
  says otherwise (providers, model, agents and instructions written in it) is carried.

Skills (task review, 2026-11-21): Codex reads `~/.codex/skills` and a project's `.agents/skills` itself (no switch found
in its config; Settings → Skills says "Uses its own"). Grok reads its own `~/.grok` skills, and Claude's and Cursor's
unless told not to: ion sets `GROK_CLAUDE_SKILLS_ENABLED=false` and `GROK_CURSOR_SKILLS_ENABLED=false`.

Codex, when `config/read` fails, ion can't name Codex's own servers to turn them off and has no switch for all of them:
a chat doesn't start ("ion couldn't turn off Codex's own servers"); ion's judge (read-only) goes on. ion never edits an agent's
own files for this; only its own folder (opencode's empty config) and per-run flags and environment.

opencode's commands get your config folder back: ion's plugin sets `XDG_CONFIG_HOME` (and blanks `ION_GATE_URL` and
`OPENCODE_CONFIG_CONTENT`) in its `shell.env` hook, so `git`, `gh` and the like read your own config as before.

**Import** reads, and only reads (1 MB cap a file; a file that can't be read is one line): Claude Code `~/.claude.json`
(`mcpServers`, and `projects[<path>].mcpServers` for ion's projects) and each project's `.mcp.json`; Codex
`$CODEX_HOME/config.toml` (default `~/.codex`) and a project's `.codex/config.toml` (`bearer_token_env_var` becomes
`Authorization: Bearer ${NAME}`); opencode `$XDG_CONFIG_HOME/opencode/{config,opencode}.json(c)` and a project's
`opencode.json(c)` (`{env:NAME}` becomes `${NAME}`); Grok `$GROK_HOME/config.toml` (default `~/.grok`) and a project's
`.grok/config.toml`. A key typed into any of them becomes a `${NAME}` you add in Settings; SSE servers are said, not
brought in. Security review, 2026-11-21: a server in a project's own file (`.mcp.json`, a project's `opencode.json`,
`.codex/` or `.grok/` config) was written by the repo, not you: it says so ("From shop's .mcp.json"), is never in Import
all or the prompts, and comes in only by name with its project's file named too (`ion mcp import repotool --from
shop:.mcp.json`). Your own servers are listed before any in a project's file, and a project's server with one of their
names is left out (a repo's `github` never hides yours). Nothing comes in before its command (or host) and keys are shown.

## Agents bring their own tools (2026-11-21, Plan 18 Task 13)

The user, 2026-11-21: "since grok build and opencode can't turn their own servers and plugins off, then i don't see the
point of disabling … frontier harnesses are already mature rather than reinventing the wheel. Hooks probably should stay
as these would need to be consistent." Each agent now brings its own by default ("Use its own tools", per agent); off
is the table above, kept.

| Agent | With its own tools | Its own hooks |
|---|---|---|
| Claude Code | Still `settingSources: []` and `strictMcpConfig: true`. ion reads its servers (yours in `~/.claude.json` and this project's entry there, minus `disabledMcpServers`; the project's `.mcp.json` ones only once turned on in ion, whatever Claude's own approvals say; `${VAR}` filled from the agent's environment only, never `ION_*`) and its enabled plugins (`installed_plugins.json` + `enabledPlugins` in `~/.claude/settings.json`; their `.mcp.json` servers with `${CLAUDE_PLUGIN_ROOT}` filled) and passes them (`mcpServers`, `plugins` with `skipMcpDiscovery`). Values travel as `${ION_MCP_*}` env references (Claude expands them in command, args, env, url and headers). Its skills: ion's skills plugin includes Claude's own folders as they are. | Never loaded: no settings files; a plugin with hooks is passed as ion's copy (links to everything but `hooks/`, the manifest without `hooks`). |
| Codex 0.153.2 | Nothing turned off: no `config/read`, `features.plugins` stays on. | Turned off as before (`hooks/list` → `hooks.state`), a plugin's too if Codex lists it there (not checked live). |
| opencode 1.18.8 | Your `mcp`, `plugin` (relative paths made `file://` whole), `agent`, `command`, `instructions` carried into ion's file; your folder's `plugin/` and `plugins/` files added as `file://` entries; ion's gate plugin first. Its own folder (`<hash>-own`; the plugin package copied from the other). Not carried: `agent/` and `command/` markdown folders. | opencode plugins are hook code and don't distinguish hooks, so yours run (Settings says so). |
| Grok 1.0.92 | Its own setup; Claude's and Cursor's servers and skills it reads stay on. | `GROK_CLAUDE_HOOKS_ENABLED=false`, `GROK_CURSOR_HOOKS_ENABLED=false`; `~/.grok/hooks` has no switch (Settings says "Its own hooks run too"). |

The gate sees every call from an own tool: Claude Code's `canUseTool` and PreToolUse hook (`mcp__<server>__<tool>`),
Codex's approvals (`mcpServer/elicitation/request`), Grok's hook (`<server>__<tool>`), opencode's plugin (`<server>_<tool>`,
kind "other": opencode doesn't say which server). ion's policy never allows an MCP call that isn't ion's own, so in Auto
each goes to the judge.

## Seen live in PR A's verification (2026-11-21, opencode big-pickle and Grok 4.7)

- opencode's `tool.started` for a bash call carries only `summary: "bash"` and `input: { cwd }`; the command arrives
  later on the permission request (ion's approval names it). An MCP call through ion's gateway comes as kind
  `other`, empty summary, `input: {}`, named `<server>_<tool>` (`everything_echo`); ion's approval names it. The CLI
  now falls back to the tool's name.
- opencode's `webfetch` reaches ion's gate with its URL (refused when no search found it and you didn't give it, with
  the reason the ion repeats), though its `tool.started` input is `{}`.
- opencode once passed ion's `ask` choices as plain strings (rejected by the tool's schema); it retried with objects.
- Grok finds an MCP tool first (`Find tool`, kind `other`), then calls `<server>__<tool>`; its web search runs on
  xAI's side, so pages it found aren't "found" for ion's fetch rule and a later `web_fetch` of them is refused.

## "/" and "@": how each agent takes a picked skill, command or server (2026-11-21, Plan 18 Task 10)

What "/" lists for a chat (`tools.picks`): the agent's own commands (Claude Code: `~/.claude/commands/*.md` and its
enabled plugins' `commands/` as `plugin:name`; opencode: `~/.config/opencode/command(s)/*.md` and its config's
`command` table; Codex: custom prompts in `~/.codex/prompts` as `prompts:name`; Grok: none found that ion can read),
then the skills that agent loads itself (Settings' `readers`), then ion's skills that are on. "@" lists the agent's own
servers (its switch on; a repo's once it's on or asks in the chat) and your mcp.json servers that are on. Resources:
listed for servers ion runs (below).

How a pick reaches the agent (`withPicks`, adapter-kit; each adapter says its `picks` style):

| Agent | Command | Skill it loads | Skill it can't load |
|---|---|---|---|
| Claude Code (`slash`) | `/name …` leads the prompt (the SDK runs its own and plugin commands) | "Use the <name> skill." (its Skill tool; ion's are in its plugin folder) | — (ion passes on skills in its plugin) |
| opencode (`slash`) | `/name …` leads the prompt (its ACP agent runs listed commands) | "Use the <name> skill." (its skill tool) | SKILL.md body as labelled data |
| Codex, Grok (`tell`) | the command's text as labelled data ("Do what the <name> command says") | "Use the <name> skill." | SKILL.md body as labelled data |

Only one command can lead a prompt; others go as text.

Checked live on Claude Code (haiku, 2026-11-21, ion's options: `settingSources: []`, a plugin folder): `/kit:plugping`
from a plugin's `commands/` ran ("PLUGIN COMMAND RAN"); `/projping` from the project's `.claude/commands` didn't ("isn't
installed in this session"). Settings-folder commands (`~/.claude/commands`, a project's) load only with a setting
source, so ion sends them as their text (`runs: false`, the tell path); plugin commands (ion's copy of your plugins)
go by name.

"@" resources: for servers ion runs (your mcp.json servers that are on), ion asks `resources/list` (started just to
ask, kept a minute; names cleaned, at most 50 per server); a pick is the mention "<server> resource <uri>", which the
agent gets as "Read the <server> resource <uri>.". An agent's own servers: by name only. Only for an agent that reads resources
(`mcpResources`: Claude Code). Live on Grok (2026-11-21): given a resource mention it found no way to read MCP resources
and searched the web, so Grok and opencode get servers by name only; ions' "@" lists servers only.

Ions and an agent's own servers (task review, 2026-11-21): Grok loads its config.toml servers whatever ion passes, so an
ion's turn leaves out any of your servers named like one of that agent's own (said in the daemon's log), and its hook
never lets on a call to an own server's name (or a name that could be one, by the `server__` prefix). A server pick is "Use the <name> connection's tools." The chat
shows your words with the picks as chips (`message.sent.skills/mentions`); the judge reads only your words. Not yet
checked live on each agent: whether opencode's ACP runs `/name` from a prompt (its TUI does), and whether Codex's
app-server expands `/prompts:` (it doesn't in our reading, so ion sends the text).

Ions: "/" lists every skill that's on (ion chief) or its project's (a project's ion); the turn is told to read a skill
(`tools {skill}`, the body as data, never run) or pass it on (`start_thread`'s `skills`/`mentions`). A skill's body
comes only from the exact skill that passed the check (folder + contents hash), only while it's on; a name two
different skills share is refused.

Ions and your servers: an ion's turn gets ion's URL for each server that's on (only its turn key); ion's gateway
gates each call for ions: the tool must be on for ions (Settings → Tools, "Ions can use", pre-filled from
`readOnlyHint && !destructiveHint`, your switch kept with a hash of name, description and labels), the input within
the limits (each text ≤ 200 chars, no 40+ base64/hex run, ≤ 2 KB), and the judge (`onlyReads`) must say allow; no or
unsure: refused with a plain line, and the ion starts a thread.
