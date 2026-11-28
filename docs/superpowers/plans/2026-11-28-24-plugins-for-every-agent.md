# Plan 24: One Set of Plugins for Every Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install a Claude-format plugin into ion once, and its skills, MCP servers and hooks work the same on Claude Code, Codex, Grok Build and opencode. What only one agent can use is labelled, and nothing is dropped silently.

**Architecture:**
- **A plugin is a Claude-format folder,** copied into ion's home at a pinned commit, with a hash, and split into parts. Each part has its own switch and exactly one home:
  - MCP servers run in ion's gateway, as today.
  - Skills load natively in each agent, from ion's copy without `hooks/`.
  - Hooks run only in ion, through a Claude-compatible runner, once per tool call.
  - Commands, subagents and output styles go natively to the agents that read them, and are labelled.
- **Marketplaces are catalogs:** ion lists them and installs from them, pinned. It never auto-updates and never installs a whole catalog.

**Tech Stack:** TypeScript, the daemon (`apps/daemon/src/tools`, `src/hooks`, `src/runs/approvals.ts`, `src/gate`, `src/mcp`), the adapters (`packages/adapters/{claude-code,codex,acp}`), `@ion/client`, the desktop app (Settings → Tools), the CLI.

**Spec:**
- `docs/research/plugins-across-agents.md` (PR #53): the compatibility tables, the per-agent mechanisms, the hard cases, security, and the recommendation and order of work.
- The user, 2026-11-28:
  - "it is binded to the respective harness which can be unpractical due to the difference in terms of plugins installed for the harnesses";
  - first audience: power users;
  - connections: both hosted and local;
  - "should we remove hooks for ions but only plain chat, and worker thread should have hooks" (agreed);
  - on reading Claude marketplaces: decide from the research.

## Global Constraints

- **Plugin hooks run in your chats and in chats an ion started, never in ion's own turns** (ion chief, project ions, report turns, Dream). That includes Grok: never pass `--plugin-dir` on an ion's turn.
- **Each part runs in exactly one place per agent.** Agents always get ion's copy without `hooks/`. A hook runs once per tool call id. This relies on the hook fix on `fix-hooks-once-in-worktree`, which must be merged before Task 3.
- **Pinned, never moving:**
  - install from a commit SHA and keep a hash of the whole folder;
  - a part whose files change is turned off until you approve it again;
  - `@latest` and moving refs are pinned at install, or the install asks first.
- **Consent per part, not per plugin.** Each part shows where it runs, for example "ion, before every tool call" or "Claude Code only". It also shows what it uses: "runs Python", "uses the network", "uses your Claude account". New parts start off.
- **No writes to any agent's real config.** Everything goes in per run: SDK `plugins`, Codex `skills/extraRoots/set` and `-c`, Grok `--plugin-dir`, opencode's `OPENCODE_CONFIG_CONTENT`.
- **ion's rules come first.** The gate's order stays: ion's own files and your "never", then plugin and your hooks, then policy, then Full or Auto's judge. A hook can refuse but never allow past ion's rules.
- **Hooks get what they need and no more:**
  - the translated payload only, with no transcript by default (`transcript_path: null`);
  - never ion's keys or gate URL;
  - ion's hook sandbox, with no network unless that part is allowed it;
  - their own timeout, capped at 60 s, with a note when it's cut.
- **Power users first:** full control and plain status, without hand-holding copy. ion's word rules still apply (`ion/plain-words`; reasonable jargon such as hook, MCP and worktree is fine).
- **Usual rules:**
  - tests first, with no real model calls in tests;
  - lab parity, code health, golden files;
  - a tour, plus a live check on opencode (`opencode-go/deepseek-v4.1-flash` once the free model is out), Grok and Codex. Claude only for its native parts, with tiny turns.
- **Plan 22 Task 5 folds in here:** each agent's own tools, and each plugin part, show their prompt size; nothing is turned off for you.

## Review Focus

1. **A plugin's files change after install** (an update, an edit, tampering): the changed part turns off and says why, and stays off until approved again. Test in Task 1.
2. **A hook that hangs, needs the network, or crashes:** it's cut at its cap and the run goes on, with "hook X was stopped after 60 s" shown on the step. A crash is the hook's failure, never a silent allow of a call it meant to block. Test in Task 3.
3. **The same plugin installed natively in an agent and in ion** (for example the user's own Claude plugin): ion shows it as installed twice and runs only ion's copy's hooks. The agent's own copy is the agent's business, flagged. Test in Task 2.
4. **Skills or plugins a repo brings** (`.claude/skills`, `.grok`, `.mcp.json` in the project): shown as the repo's, never counted as installed, and never turned on by installing a plugin. Test in Task 2.
5. **A hook that needs Claude-only fields** (`transcript_path`, Claude's `session_id`): it gets honest values or `null`, and the part is marked "can't fully run on <agent>". It is never shown as working when its rule can't match. Test in Task 3.

---

### Task 1: Plugins in ion's home, split into parts

**Files:**
- `apps/daemon/src/tools/plugins/` (new): `install.ts` (fetch a git source at a commit, copy, hash), `parts.ts` (read a Claude-format folder into parts), `catalog.ts` (read a `.claude-plugin/marketplace.json`);
- the reuse of `apps/daemon/src/tools/plugin-copy.ts` (copy without `hooks/`, drop `allowed-tools`);
- `packages/schema` (the `plugins.*` commands and the part types);
- the CLI: `ion plugins`, `ion plugins add <git-url>[@<sha>]`, `ion plugins catalog <git-url>`, `ion plugins part <plugin> <part> on|off`, `ion plugins remove <plugin>`.

**Interfaces (produces):**
- `type PluginPart = { id: string; kind: "mcp" | "skill" | "hook" | "command" | "agent" | "output-style" | "other"; runsIn: AgentId[] | "ion"; on: boolean; uses: ("python" | "node" | "network" | "claude-account" | "shell")[]; why?: string }`
- `type InstalledPlugin = { name: string; source: string; commit: string; hash: string; parts: PluginPart[] }`
- `Plugins.list(): InstalledPlugin[]`, `Plugins.add(source: string, commit?: string): InstalledPlugin`, `Plugins.setPart(name: string, partId: string, on: boolean)`, `Plugins.remove(name: string)`
- `Plugins.forRun(agent: AgentId, ionTurn: boolean): { skillRoots: string[]; hooks: HookPart[]; mcp: McpPart[]; native: NativePart[] }` (empty hooks and native parts when `ionTurn`). `AgentId` is the existing harness id. `HookPart`, `McpPart` and `NativePart` are `PluginPart` narrowed by `kind`, plus the part's folder in ion's copy and, for hooks, its event, matcher, command and timeout.

Steps:
- [ ] Tests:
  - "a Claude-format plugin is split into its parts, each off";
  - "a part's `runsIn` follows the research table" (commands and subagents: Claude, plus Grok; other parts as the table says);
  - "install pins the commit and hashes the folder";
  - "a changed file turns its part off with a reason" (Review Focus 1);
  - "a marketplace is listed, nothing installed";
  - "an `@latest` server is pinned or asks";
  - "`forRun` on an ion's turn has no hooks and no native parts".
- [ ] FAIL → implement → PASS → install three of the research's plugins into a temp ion home with the CLI, and check the parts list → commit `feat: plugins live in ion, split into parts`.

### Task 2: Skills natively on all four agents

**Files:** `packages/adapters/claude-code/src/session.ts` (as today, from `forRun`), `packages/adapters/codex/src` (`skills/extraRoots/set` per app-server), `packages/adapters/acp/src` (Grok: `--plugin-dir <ion's copy without hooks>`; opencode: `skills.paths` in `OPENCODE_CONFIG_CONTENT`), `apps/daemon/src/runs` (pass `forRun().skillRoots`).

**Interfaces (consumes):** `Plugins.forRun` from Task 1.

Steps:
- [ ] Tests (adapter contract tests, no model):
  - "each agent's start options carry ion's skill roots";
  - "Grok's `--plugin-dir` folder has no `hooks/`";
  - "an ion's turn gets no `--plugin-dir` and no plugin skills";
  - "a skill the agent already has natively is shown as installed twice" (Review Focus 3);
  - "a repo's own `.claude/skills` is labelled the repo's" (Review Focus 4).
- [ ] FAIL → implement → PASS → live: one plugin skill answered from on opencode, Grok and Codex, and Claude with one tiny turn → commit `feat: plugin skills on every agent`.

### Task 3: Plugin hooks before a tool runs, on every agent

**Files:** `apps/daemon/src/hooks/compat.ts` (new: the Claude-compatible runner), `apps/daemon/src/runs/approvals.ts` (plugin hooks next to your hooks, in the same place in the order), each adapter's gate mapping (`packages/adapters/*/src/gate.ts`: tool names and inputs translated to Claude's), golden files of the translated payloads.

**Interfaces:**
- Consumes: Task 1's `HookPart`, and the once-per-call-id fix from `fix-hooks-once-in-worktree`.
- Produces: `runCompatHook(part: HookPart, call: GateCall, run: RunContext): Promise<{ decision: "allow" | "deny"; reason?: string; note?: string }>`

Steps:
- [ ] Tests:
  - "a PreToolUse hook refuses with `permissionDecision: \"deny\"`, `decision: \"block\"` or exit 2";
  - "a hook can't allow past ion's own files rule or your never";
  - "the payload's tool names and inputs match Claude's for each agent" (golden);
  - "a hook gets the worktree as `cwd`, `CLAUDE_PLUGIN_ROOT`, and no ion keys";
  - "a hung hook is cut at its cap and the step says so" (Review Focus 2);
  - "a hook needing `transcript_path` gets null and its part says it can't fully run" (Review Focus 5);
  - "no network unless the part is allowed it".
- [ ] FAIL → implement → PASS → live: hookify's `rm -rf` rule refuses on opencode, Grok and Codex. Check that it fired once per call in the events → commit `feat: plugin hooks run in ion for every agent`.

### Task 4: Prompt, session start and turn end

**Files:** `apps/daemon/src/runs` (before the prompt is sent; a new agent session; `run.finished`), `apps/daemon/src/hooks/compat.ts`.

Steps:
- [ ] Tests:
  - "UserPromptSubmit can block a message or add context to it";
  - "SessionStart runs once per new agent session, not per run or retry, and its context goes into that run's instructions once";
  - "Stop's block becomes one follow-up message, at most 3 in a row";
  - "none of these run on an ion's turn".
- [ ] FAIL → implement → PASS → live on Grok and opencode with a plugin that adds context at session start → commit `feat: plugin hooks on prompt, session start and turn end`.

### Task 5: After a tool runs

**Files:** each adapter registers an after-tool hook like its gate (Claude `PostToolUse`, Codex `postToolUse`, Grok `PostToolUse`, opencode `tool.execute.after`); `apps/daemon/src/gate` (an after-tool endpoint); `compat.ts`.

Steps:
- [ ] Tests:
  - "a PostToolUse hook sees the tool's result in Claude's shape, per agent" (golden);
  - "its added context reaches the agent";
  - "an agent without it lists the part as not on <agent>".
- [ ] FAIL → implement → PASS → live on the four agents (Claude: one tiny turn) → commit `feat: plugin hooks after a tool runs`.

Input rewriting (`updatedInput`) stays out of this plan. When it comes, the rewritten input is re-checked by ion's rules, policy and the judge.

### Task 6: Settings → Tools → Plugins, and each part's size

**Files:** `apps/desktop/src/settings/` (a Plugins page next to Connections, Automations and Skills), the design lab first (`docs/design/ion-design-lab.html`), `ion plugins` output.

- **Lists:** installed plugins, each part's switch, where it runs, what it uses, and its prompt size (Plan 22 Task 5's count and size, including each agent's own tools, with "Not used lately" after 30 days).
- **Catalogs:** add one by URL. Install pins and asks part by part.
- **An agent's own plugins:** shown read-only, with "Use in all agents", which installs ion's copy and keeps the agent's own as it is.
- **Connections:** both hosted (OAuth) and local servers, as today.

Steps:
- [ ] Tests:
  - "a part's row says where it runs and what it uses";
  - "installing asks per part, all off";
  - "Use in all agents adds ion's copy and leaves the agent's own";
  - "sizes show per agent; nothing is turned off".
- [ ] FAIL → implement → PASS → lab side by side at 1440×900 and 900×700 → commit `feat: plugins in Settings, part by part`.

### Task 7: Verify end to end

- **The live checks:** install the research's five plugins through the app. Check each part's row against the research table. Run a chat on each agent that uses a skill, hits a refusing hook, and uses an MCP server. Message ion chief and a project ion, and confirm no plugin hook or native part ran in their turns.
- **The ion evals and judge evals:** still pass, since hooks sit in front of the judge.
- **The tour,** plus a walkthrough milestone with the compatibility table as it now runs.
- **Docs:** `docs/research/plugins-across-agents.md` (what changed from the research), `docs/README.md`, AGENTS.md (the new folder).
- [ ] Run → fix what fails (each with a failing test first) → commit `test: plugins checked on every agent end to end`.
