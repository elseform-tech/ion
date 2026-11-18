# ion docs index

| Doc | What it's for |
|---|---|
| [design/ion-design-lab.html](design/ion-design-lab.html) | The product spec: screens, design system, architecture, engineering, CLI (canvas v34). Open in a browser. Since Plan 06: approvals (the approval bar, allow/deny) are replaced by agents' questions (Needs you, answered by choice), and every chat has a project, so "Plain chat" means a chat in `default`. |
| [architecture/contract.md](architecture/contract.md) | Event envelope and types, adapter interface, retries, import walls. |
| [research/acp-and-harnesses.md](research/acp-and-harnesses.md) | ACP protocol, how each coding agent is launched and signed in, quota policy for tests. |
| [../AGENTS.md](../AGENTS.md) | How to work in this repo: layout, walls, rules. |

## Plans

| Plan | Status |
|---|---|
| [01 Foundation](superpowers/plans/2026-11-17-01-foundation.md) | Done |
| [02 Adapters](superpowers/plans/2026-11-17-02-adapters.md): adapter kit, Claude Code, Grok Build and opencode (ACP), `ion ask` | Done |
| [03 Workspace and needs](superpowers/plans/2026-11-17-03-workspace-needs.md): worktree per chat, needs, run queue, retries | Done |
| [04 Context](superpowers/plans/2026-11-17-04-context.md): chat continuity, history and memory for ions (daemon MCP), model catalogs | Done |
| [05 Access](superpowers/plans/2026-11-18-05-access.md): Full access or Auto (ion decides), per message, project or default | Done |
| [06 Every tool call through ion](superpowers/plans/2026-11-18-06-gate-and-ask.md): each agent's pre-tool hook reports to ion; agents ask you (decisions, outcomes) instead of approvals; every thread has a project (`default`) | Done |
| [07 Desktop app](superpowers/plans/2026-11-18-07-desktop.md): Tauri shell, design system, Chats screen (sidebar, timeline, composer, question bar, changes panel) | Done |
| 08 ion chief and Ions screens. Also, in threads ion started or manages (never chats you drive yourself): agents' questions reach the project's ion first (it answers from your decisions, else passes them on with context); it spots repeated questions and suggests "always" decisions, holds chats whose questions conflict, and flags decisions that keep leading to failed runs. Decide whether `default` gets the same treatment, since it pools every chat without a project | Not written |
| 09 Routines, Activity, Artifacts, Tools | Not written |
| 10 Suggestions | Not written |
| 11 More adapters (Cursor, Gemini CLI, Codex via ACP) | Not written |

## Packages

| Package | Docs |
|---|---|
| `@ion/schema` | `packages/schema/README.md` |
| `@ion/config` | `packages/config/README.md` |
| `@ion/client` | `packages/client/README.md` |
| `@ion/design-system` | `packages/design-system/README.md` |
| `@ion/desktop` | `apps/desktop/README.md` |
| `@ion/daemon` | `apps/daemon/README.md` |
| `@ion/cli` | `apps/cli/README.md` |
| `@ion/lint-rules` | `tools/lint-rules/README.md` |
| `@ion/adapter-kit` | `packages/adapter-kit/README.md` |
| `@ion/adapter-claude-code` | `packages/adapters/claude-code/README.md` |
| `@ion/adapter-acp` | `packages/adapters/acp/README.md` |
| `@ion/adapter-fake` | `packages/adapters/fake/README.md` |
| `@ion/health` | Code-health ratchet: see "Code health" in `AGENTS.md`; baseline in `health/baseline.json` |
