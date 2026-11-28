# Plugins across agents (research, 2026-11-28)

The question (the user, 2026-11-28): plugins, MCP servers, skills and hooks are tied to each agent today, and what's
installed differs per agent. Could ion host Claude-format plugins once, so all four agents get them equally?

The design under test:

- MCP servers (local and hosted) go through ion's gateway, for every agent.
- Skills reach every agent: natively where it reads `SKILL.md` folders, else through ion.
- Hooks on before-tool, after-tool, session start, prompt submit and turn end are hosted by ion.
- One agent's own features (Claude subagents, slash commands, output styles) stay native to it, labelled.
- Anything that can't be mapped is listed, never dropped quietly.
- Each part runs in exactly one place per agent (no double firing).
- Plugin hooks run in plain chats and worker chats, never in ion's own turns.

Short answer: **mostly yes, and better than expected.** Every agent can take skills natively without installing
anything. MCP through ion's gateway works on all four (seen live on three today). ion's gate already lets a Claude
`PreToolUse` hook block a call on every agent (seen live on Grok, Codex and opencode). What's missing: after-tool
hooks, context that hooks add, rewriting a call's input, and de-duplication. Some popular hooks are Claude-only by
nature and should stay that way.

Versions: Claude Code 2.1.332 (Agent SDK 0.3.326), Codex 0.153.2, Grok Build 1.0.92, opencode 1.18.8.

## The plugins

Fetched with `git clone --depth 1` into a scratch folder in the worktree, read as data, deleted afterwards. Only
hookify's and superpowers' hook scripts were run, and only in the tests below.

| Plugin | Source (commit) | Why picked |
|---|---|---|
| superpowers | `obra/superpowers` (`22f0b46`) | 14 skills; a `SessionStart` hook that adds context. Ships its own manifests for Codex, Cursor, opencode and others |
| hookify | `anthropics/claude-plugins-official` `plugins/hookify` (`0fbfda5`) | Hooks on `PreToolUse` (blocks), `PostToolUse`, `Stop` and `UserPromptSubmit`; 4 commands, 1 subagent, 1 skill |
| security-guidance | same repo, `plugins/security-guidance` | Hooks on `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop` that call a Claude model and run in the background |
| feature-dev | same repo, `plugins/feature-dev` | 1 slash command, 3 subagents |
| MCP plugins: context7, github, playwright | same repo, `external_plugins/*` | A hosted server with no key, a hosted server with a key, a local `npx` server |

Also read: `explanatory-output-style` (the old output style, now a `SessionStart` hook).

## Every part, sorted

Columns: where the part should run, and which agents it works on if ion does what's in the Recommendation.
"Today" is what ion does now.

### Hooks

| Plugin · hook | Event | Reads | Returns | Works on |
|---|---|---|---|---|
| hookify `pretooluse.py` | PreToolUse | `tool_name` (only `Bash`, `Edit`, `Write`, `MultiEdit` pick a rule set), `tool_input.command / file_path / content / new_string / old_string / edits`, `hook_event_name`. Rules from `.claude/hookify.*.local.md` **in the current folder** | Block: `hookSpecificOutput.permissionDecision: "deny"` + `systemMessage`. Warn: `systemMessage` only. Always exits 0 | **All four, through ion's gate.** Seen live today on Grok, Codex and opencode. Needs tool names and inputs translated (below) |
| hookify `posttooluse.py` | PostToolUse | same as above | `systemMessage` (warn), or deny (meaningless after the call) | All four have a native after-tool hook. ion registers none today and has no after-tool hook event: **none today, all four after new work** |
| hookify `userpromptsubmit.py` | UserPromptSubmit | `user_prompt` | `systemMessage`; it can't block | **All four via ion**: ion sends every prompt itself, so it can run these before sending. Not built |
| hookify `stop.py` | Stop | `reason`, **`transcript_path`** (reads the file: Claude's own transcript) | `decision: "block"` + `reason`: Claude keeps going | Claude natively. Others: ion sees the turn end and could send a follow-up, but there's no Claude transcript to give. **Partial** |
| superpowers `session-start` | SessionStart (`startup\|clear\|compact`) | nothing from stdin; env `CLAUDE_PLUGIN_ROOT`, `CURSOR_PLUGIN_ROOT`, `COPILOT_CLI` pick the output shape | `hookSpecificOutput.additionalContext`: the whole `using-superpowers` skill, which says "use the Skill tool" | ion controls each agent's instructions, so it could add the text on every agent. ion's `run.started` fires per run, not per session (below). **All four after new work**; the text is Claude-flavoured |
| explanatory-output-style `session-start.sh` | SessionStart | nothing | `additionalContext` (a style instruction) | Same as above: **all four after new work** |
| security-guidance (one script, `security_reminder_hook.py`, 15 k lines of Python) | SessionStart: `ensure_agent_sdk.py` **installs `claude_agent_sdk` with pip** (180 s timeout). UserPromptSubmit: takes a git snapshot. PostToolUse on `Edit\|Write\|MultiEdit\|NotebookEdit`: regex checks. PostToolUse on `Bash` with `"if": "Bash(git*commit*)"` and `asyncRewake`. Stop with `asyncRewake` | `session_id`, `tool_name`, `tool_input`, `tool_response`, `cwd`, `hook_event_name`; `ANTHROPIC_*` keys or the `claude` CLI; git | PostToolUse: `additionalContext` warnings. Stop: exit 2 (keep going) after **two model calls on your Claude account**, in the background (`asyncRewake`) | **Claude only.** `if:`, `asyncRewake`, `rewakeMessage` are Claude-only hook fields; it calls Claude models with your keys; it installs packages at session start. Leave native to Claude, labelled |

### Skills, commands, subagents, MCP

| Plugin · part | Row | Works on | Why |
|---|---|---|---|
| superpowers: 14 skills | skills | **All four natively** | Each agent reads `SKILL.md` folders without installing (agent table). Bodies name Claude tools (`Skill`, `Task`, `TodoWrite`); superpowers fixes that itself for opencode with a plugin that rewrites the words, ion can't |
| hookify: `writing-rules` skill | skills | **All four** | Seen live: each agent answered from it (as text in the prompt today on Grok, Codex, opencode) |
| hookify: 4 commands (`/hookify`, `/hookify:list`, …) | Claude-native, labelled | Claude, Grok natively (Grok listed them from `--plugin-dir`); opencode can take them as its `command` table; Codex: as text only | `allowed-tools` (Claude tool names) is dropped on copy anyway |
| hookify: `conversation-analyzer` subagent | Claude-native, labelled | Claude; Grok reads plugin agents (listed `hookify:conversation-analyzer` live) | `model: inherit`, `tools: ["Read","Grep"]` are Claude names |
| feature-dev: `/feature-dev` command | Claude-native | Claude (live: listed as `feature-dev:feature-dev`); Grok reads it; others as text | The command tells the model to "launch 2–3 code-explorer agents": useless without the subagents |
| feature-dev: 3 subagents | Claude-native, labelled | Claude (live: listed in the init message); Grok reads plugin agents | `model: sonnet` and Claude tool lists (`NotebookRead`, `KillShell`, `BashOutput`) |
| context7 (`http`, no key) | MCP → ion's gateway | **All four** | Same path as the probe server below. Its README says it may ask you to sign in: ion's OAuth handles that |
| github (`http`, `Authorization: Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}`) | MCP → ion's gateway | **All four** | ion fills `${NAME}` from your keychain; the agent never sees the key |
| playwright (`npx @playwright/mcp@latest`) | MCP → ion's gateway (ion runs it) | **All four** | `@latest` downloads new code on every start: pin it. It opens a real browser |
| superpowers: `hooks: {}` in its Codex manifest, Codex/Cursor/opencode manifests | — | — | Not a part: shows authors already ship per-agent variants |

Nothing found that can't be listed. What can't run somewhere is listed with the reason above, never dropped.

## What each agent gives ion

| | Claude Code | Codex | Grok Build | opencode |
|---|---|---|---|---|
| ion sees a call before it runs | Yes: an Agent SDK `PreToolUse` callback (`packages/adapters/claude-code/src/gate.ts`) | Yes: a `PreToolUse` hook passed with `-c`, trusted by hash (`packages/adapters/codex/src/gate.ts`) | Yes: a `PreToolUse` hook in `~/.grok/hooks/ion-gate.json`, inert without `ION_GATE_URL` (`packages/adapters/acp/src/gate.ts`) | Yes: ion's plugin, `tool.execute.before` (`packages/adapters/acp/plugin/ion-gate.js`) |
| ion can block it | Yes (live) | Yes (live) | Yes (live) | Yes (live) |
| The agent can rewrite the input | Yes: `updatedInput` (Claude hooks docs, code.claude.com/docs/en/hooks) | Not checked | Its binary has `updatedInput`; not checked live | Yes: the hook mutates `output.args` (`@opencode-ai/plugin` 1.18.8 `Hooks`) |
| ion's gate can rewrite it | No: the gate answers allow or deny only (`apps/daemon/src/gate/server.ts`) | No | No | No |
| After-tool hook in the agent | `PostToolUse` (SDK `hooks`) | `postToolUse` (`HookEventName`, `codex app-server generate-ts`) | `PostToolUse` (in its binary) | `tool.execute.after`, which may also rewrite the output |
| ion sees after-tool today | Only as `tool.finished` in the event stream; no hook event, can't add context | same | same | same |
| Session start | `SessionStart` | `sessionStart` | `SessionStart` (in its binary) | `event` (`session.created`), `experimental.chat.system.transform` |
| Prompt submit | ion sends the prompt itself (`message.sent`) on every agent; each agent also has its own hook (Claude `UserPromptSubmit`, Codex `userPromptSubmit`, Grok `UserPromptSubmit`, opencode `chat.message`) | | | |
| Turn end | ion sees `run.finished` on every agent; native: Claude `Stop`, Codex `stop`, Grok `Stop`, opencode `session.idle` | | | |
| Reads `SKILL.md` natively | Yes: SDK `plugins: [{type: "local"}]`; ion does this today (`docs/research/skills.md`) | Yes. **`skills/extraRoots/set`** on the app-server adds a folder for that process: checked with an empty `CODEX_HOME`, `skills/list` then showed `hookify:writing-hookify-rules`; nothing written | Yes. **`grok agent --plugin-dir <dir> stdio`** loads a whole Claude-format plugin for that process only (`grok agent --help`); checked live | Yes. **`skills.paths`** in `OPENCODE_CONFIG_CONTENT`: `opencode debug skill` under a temp `HOME` listed the hookify skill. It also reads a repo's `.claude/skills` unasked |
| Loads a Claude plugin without installing | Yes, including its **hooks**: with `settingSources: []`, hookify's own hook blocked `rm -rf` (live). This is why ion copies plugins without `hooks/` (`apps/daemon/src/tools/plugin-copy.ts`) | Skills (above), MCP (thread `config`), hooks (`-c`). No Claude-format commands or subagents; Codex has its own `.codex-plugin` format | Yes, all of it: `grok plugin validate` accepts each Claude plugin above ("components: … skill dir(s), command dir(s), agent dir(s), hooks / MCP servers"); `--plugin-dir` ran hookify's hook natively, no trust prompt | Skills (above), MCP, `command` and `agent` tables in the inline config; hooks only as opencode JS plugins (another format) |
| What ion passes today | ion's skills; Claude's own plugins copied without hooks | Nothing (skill picked → its text in the prompt) | Nothing (same) | Nothing (same) |
| ion's own turns | No plugin, no hooks (`apps/daemon/src/ions` never calls `beforeTool`; `catalog.ts` skips runs with no chat or an `ion:` chat) | same | same, but your own `~/.grok` hooks and plugins still run (no switch, known) | same |

ion's hooks today (`apps/daemon/src/hooks`): "Before a tool runs" (`tool.before`: runs in order, exit 2 refuses with
its stderr, 10 s each, 15 s in all, sandboxed, in the project's folder) and fire-and-forget event hooks (`run.started`,
`run.finished`, `run.failed`, …). There is no after-tool, prompt or session event, and no way for a hook to add
context. ion's gate order (`apps/daemon/src/runs/approvals.ts` `verdict`): ion's own files, your "never" and the
agent's own deny rules, **then your hooks**, then policy, then Full or Auto's judge. So a plugin hook's no beats
Full access, and the judge never sees a call a hook refused.

## Live runs

All in a temp ion home under the worktree's scratch folder (`ION_HOME=…/.research/ion-home`, `ION_TOUR=1`,
`ION_AGENTS_HOME` an empty folder so ion read none of your agents' configs, a clean `env -i` with no wrapper
variables). The opencode run was made after a restart with `CLAUDE_CONFIG_DIR` set to an empty folder, so ion's brain
couldn't fall back to Claude; ion's store shows no Claude run or usage at any point. `[ion] quick` and
`[access] judge` were opencode; every run used `access: "full"` (hooks still run in Full: see the order above).

Set up through ion's own API (as the app does), with a small driver script in scratch:

- **Hook:** `tools.addHook { event: "tool.before", run: "node claude-hook-shim.mjs PreToolUse <hookify> <project> 'python3 \"${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.py\"'" }`.
  The shim turns ion's payload (`{type, chatId, runId, data: {tool, kind, summary, input}}`) into Claude's
  (`hook_event_name`, `tool_name`, `tool_input`, `cwd`, `session_id`), sets `CLAUDE_PLUGIN_ROOT` and
  `CLAUDE_PROJECT_DIR`, runs the hook, and maps a deny to exit 2 + stderr. hookify's example rule
  `block-dangerous-rm` (`rm\s+-rf` → block) in the project's `.claude/`.
- **Second hook:** `run.started` running superpowers' `session-start` through the same shim.
- **Skill:** `ion skills add writing-hookify-rules --from <hookify>/skills/writing-rules`, turned on, and picked in the
  message (`skills`).
- **MCP:** a 20-line stdio server in scratch (`marker` → `MCP-MARKER-7731`) in ion's `mcp.json`, turned on, mentioned.
- **Prompt:** "1) Run exactly `rm -rf ./scratch-dir` 2) call the probe connection's marker tool 3) using the
  writing-hookify-rules skill, name the values a rule's action field can take."

| Agent | What fired | Reply | Cost |
|---|---|---|---|
| opencode `opencode-go/deepseek-v4.1-flash` | hookify blocked `rm -rf` (`approval.resolved by: hook`); `probe_marker` through ion's gateway returned the marker; hook ran once per call | "Step 1 was blocked by a "dangerous rm" hook rule … Marker word: MCP-MARKER-7731 … `warn` (default) or `block`." | 232 in / 52 out tokens, $0.0023 |
| Grok `grok-4.7` | hookify blocked `rm -rf`; Grok found then called `probe__marker` through ion's gateway; **the hook ran twice for that one MCP call** | "blocked by the `block-dangerous-rm` hook … `MCP-MARKER-7731` … `warn` or `block`." | 35,125 in / 249 out, $0.111 |
| Codex `gpt-5.6-luna` | hookify blocked `rm -rf` (before Codex even started the item); `mcp__probe__marker` through the gateway; **the hook ran twice for `mcp__ion__decisions`** | "blocked by the active safety hook … Marker: `MCP-MARKER-7731` … `warn` and `block` (default: `warn`)." | 182,131 in / 1,025 out (ChatGPT plan, 0 % of either window) |

`scratch-dir` was never deleted. The free opencode models were used up (`big-pickle`, `deepseek-v4.1-flash-free`:
"free usage is used up"; one `opencode-go` free model: "This API key has expired"): 4 failed runs, 0 tokens.

**`run.started` ran the SessionStart hook 6 times for 6 runs**, including a retry of the same message. Its context
(the superpowers text) went nowhere: ion's event hooks can't return anything.

Outside ion (scratch scripts, same options ion uses):

- **Claude Code (haiku), one turn**, Agent SDK with `settingSources: []`, `strictMcpConfig`, `permissionMode:
  "default"`, `plugins: [hookify, feature-dev]` raw, plus an SDK `PreToolUse` callback standing in for ion's gate.
  Init listed agents `feature-dev:code-architect`, `feature-dev:code-explorer`, `feature-dev:code-reviewer`,
  `hookify:conversation-analyzer`; commands `hookify:*`, `feature-dev:feature-dev`; skill `hookify:writing-rules`.
  "Run `rm -rf ./scratch-dir`": the SDK callback saw the call, then **hookify's own plugin hook blocked it**
  ("PreToolUse:Bash hook error: Blocked by hook"). 4 in + 18,835 cache-write + 18,686 cache-read / 278 out, $0.0042.
- **Grok, `grok agent --plugin-dir <hookify> stdio`** (a 50-line ACP client in scratch; `GROK_CLAUDE_*` off):
  listed `writing-hookify-rules`, `hookify`, `hookify:conversation-analyzer`; with a rule blocking `HOOKPROBE`,
  `echo HOOKPROBE` came back "Hook denied: denied by hook 'plugin/hookify/hooks:pre_tool_use[0].hooks[0]'". Two
  turns: 103,307 tokens ($0.139; the model also read the plugin's files to answer) and 57,523 ($0.072).
- **Codex app-server, empty `CODEX_HOME`**, no model call: `skills/extraRoots/set` then `skills/list` (above).
- **opencode `debug skill`, temp `HOME`**, no model call (above).
- **Offline**, the shim alone: hookify's four hooks and both `SessionStart` scripts with translated payloads. The
  `SessionStart` scripts returned their `additionalContext`; hookify's `userpromptsubmit` and `stop` returned
  nothing (no rule for them).

Totals: Claude 278 output tokens ($0.004); Grok ~196 k tokens ($0.32); Codex ~183 k tokens (plan); opencode 284
tokens ($0.002).

## Hard cases

- **Tool names and inputs differ.** hookify only loads its bash rules when `tool_name == "Bash"`. ion has to name the
  call the Claude way: opencode `bash`, Grok `run_terminal_command`, Codex `exec_command` → `Bash`. Edits are worse:
  Codex's `apply_patch` is a patch, not `old_string`/`new_string`; Grok's `search_replace` and opencode's
  `edit` (`oldString`/`newString`) map. MCP names come three ways: Claude and Codex `mcp__server__tool`, Grok
  `server__tool`, opencode `server_tool` (opencode doesn't say which server; ion's gate reports it as `other`). The
  throwaway shim got Codex's wrong (`mcp__mcp__ion__decisions`). Translation belongs in each adapter, next to the
  gate's own mapping, with golden tests.
- **Double firing exists today.** One MCP call ran a "before a tool runs" hook twice on Grok and on Codex: ion checks
  the same call at more than one point (the agent's hook, its permission prompt, ion's gateway) and runs your hooks at
  each check not matched to an earlier allow (`approvals.ts`: `decide`, `gate`, `gateway`). A plugin hook with side
  effects (a counter, a log, a model call) would run twice. Hooks need to run once per tool call id.
- **Native plugin loading brings hooks along.** On Claude (seen) and Grok (seen), a plugin passed as a folder runs its
  own hooks. If ion hosts a plugin's hooks and also hands the agent the raw folder, they fire twice. Always hand
  agents ion's copy without `hooks/` (the copier exists), and run hooks only in ion.
- **SessionStart isn't `run.started`.** Claude's fires once per session (`startup`, `resume`, `clear`, `compact`);
  ion's fires on every run, retries included. Map it to "a new agent session", and deliver `additionalContext` in
  that run's instructions, once.
- **Hooks that read Claude-only fields.** `transcript_path` (hookify's stop rules; Claude's JSONL format), `session_id`
  as Claude's own, `permission_mode`, `tool_response` in Claude's shape, `CLAUDE_PROJECT_DIR`. ion can give honest
  values (its run id, the worktree) and `null` for the transcript. A rule that needs the transcript then never
  matches, which should be shown, not hidden.
- **Hooks that need Claude features.** `asyncRewake`, `if: "Bash(git*commit*)"`, `rewakeMessage`, `shell:
  "powershell"`, prompt and agent hook types. security-guidance depends on them and calls Claude itself. Native to
  Claude only, labelled.
- **Hook output shapes.** Block can be `permissionDecision: "deny"`, `decision: "block"`, or exit 2. Context can be
  `additionalContext` (nested or top level), `additional_context` (Cursor), plain stdout (UserPromptSubmit), or
  `systemMessage` (shown to the user, not the model). superpowers picks its shape from which `*_PLUGIN_ROOT` is set,
  so ion must present itself as Claude Code (set only `CLAUDE_PLUGIN_ROOT`) and parse Claude's shapes.
- **Rewriting input.** No hook here rewrites, but Claude's `updatedInput` is common in the wild. ion's gate returns
  only allow or deny. All four agents can rewrite natively (Codex not checked), so adding `input` to ion's gate answer
  is doable per adapter. A rewrite must be re-checked: rewrite first, then ion's own files rule, policy and Auto
  judge the new input, never the old one.
- **Ordering with ion's gate and Auto.** Today: ion's own files and your "never" first, then hooks, then policy, then
  Full or the judge. Keep it: a plugin hook can refuse but never allow past ion's rules. Claude runs matching hooks in
  parallel (hooks docs), so ion's gate and a native plugin hook would race; another reason to host hooks only in ion.
- **Where hooks run.** ion runs hooks in the project's folder, not the chat's worktree. hookify reads
  `.claude/hookify.*.local.md` from its current folder: it worked because the rule was in the project's folder. A
  rule written in a chat's worktree wouldn't be seen. The hook's folder should be the run's worktree.
- **Time limits.** ion gives a before-tool hook 10 s and 15 s for all; hookify asks for 10 s, security-guidance's
  SessionStart for 180 s (a pip install). Respect the plugin's timeout up to a cap, and say when it's cut.
- **ion's own turns.** Holds today for ion-hosted hooks and skills. Grok still runs your own `~/.grok` hooks and
  plugins in ion's turns (no switch). If ion starts passing `--plugin-dir` to Grok, it must not on ion's turns.

## Security

- **A plugin hook is code from a stranger that runs on every tool call.** It sees the tool's input (file contents,
  commands, sometimes keys in them), the project and chat names, and, if given, the transcript. Give hooks the
  translated payload only, no transcript by default, never ion's keys or gate URL, and keep ion's hook sandbox
  (ion's folders denied, agents' configs read-only).
- **Hooks reach the network and install things.** security-guidance's SessionStart runs `pip install` and its Stop
  hook sends your diff to a model with your Anthropic keys. Consent must say so: "runs Python, uses the network, uses
  your Claude account". ion's hook sandbox should block network unless the plugin is allowed it.
- **Pin everything.** Install from a commit SHA, keep a hash of the whole folder (ion's consent marks already hash
  what a hook runs), and turn a part off when its files change. Never follow `@latest` (`@playwright/mcp@latest`) or
  a marketplace's moving ref without asking.
- **Consent per part, not per plugin.** One plugin can bring harmless skills and an aggressive hook. Show each part
  with where it will run ("ion, before every tool call", "Claude Code only") and turn each on separately. Parts
  added this way start off, as ion's `skills add` and `hooks add` do now.
- **Repos bring their own.** opencode reads a repo's `.claude/skills` unasked; Grok reads a trusted folder's
  `.grok`; Codex lists user-scope skills even with an empty `CODEX_HOME` (from outside it). ion should name
  repo-supplied parts as the repo's, as it does for a repo's `.mcp.json`.
- **Skills can run shell lines.** ion already disables a skill's `` !`command` `` on Claude
  (`disableSkillShellExecution`) and drops `allowed-tools` and `hooks` from copies. The same copy should be what every
  agent gets.

## Recommendation

**Read Claude-format plugins, yes. Read Claude marketplaces only as a catalog.** The Claude plugin folder is already
the common format: Grok validates and runs it as is, superpowers ships a Claude manifest first, and every agent can
take its skills natively. A marketplace (`.claude-plugin/marketplace.json`) is a list of sources: ion can show it and
install from it, pinned to a commit, but never auto-update or install everything in it.

**An ion plugin** should be: a Claude-format plugin folder, copied into ion's home at a pinned commit with a hash,
split into parts, each with its own switch and one home:

| Part | Runs in | How |
|---|---|---|
| MCP servers | ion's gateway, every agent | As today: ion runs local ones, fills keys, gates each call |
| Skills | each agent, natively | Claude: plugin copy (today). Codex: `skills/extraRoots/set`. Grok: `--plugin-dir` with ion's copy (no hooks). opencode: `skills.paths` in the inline config |
| PreToolUse | ion's gate | A Claude-compat runner: translated payload and tool names per adapter, Claude output shapes read, once per tool call id. Later: `updatedInput`, re-checked |
| UserPromptSubmit | ion, before it sends the prompt | Block, or add the context to the message |
| SessionStart | ion, when it starts a new agent session | `additionalContext` added to that run's instructions, once |
| Stop | ion, at the turn's end | `decision: "block"` becomes a follow-up message (as ion's queue does), with a cap |
| PostToolUse | a new after-tool hook in each adapter | All four agents have one; ion registers it like the gate. Until then: listed as "not on <agent>" |
| Commands, subagents, output styles, Claude-only hook fields | Claude natively; Grok where it reads them | Labelled "Claude Code only" (or "Claude Code, Grok"); elsewhere a command goes as its text |
| Anything else | nowhere | Listed with the reason |

Order of work, smallest first: skills natively on all four (three small adapter changes), de-duplicate hook runs by
tool call id, the PreToolUse runner, prompt and session-start context, then after-tool hooks and input rewriting.
