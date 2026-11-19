# ion docs index

| Doc | What it's for |
|---|---|
| [design/ion-design-lab.html](design/ion-design-lab.html) | The product spec: screens, design system, architecture, engineering, CLI (canvas v34). Open in a browser. Since Plan 06: approvals (the approval bar, allow/deny) are replaced by agents' questions (Needs you, answered by choice), and every chat has a project, so "Plain chat" means a chat in `default`. Since Plan 09: the sidebar's project groups (star to keep a project open, "N more", rename and archive), shimmer instead of spinners, the changed-files box, the question box above a locked composer. |
| [architecture/contract.md](architecture/contract.md) | Event envelope and types, adapter interface, retries, import walls. |
| [routines.md](routines.md) | Routines: where they live, the schedule format, how the daemon runs them, Activity, the CLI. |
| [research/acp-and-harnesses.md](research/acp-and-harnesses.md) | ACP protocol, Codex's app-server, how each coding agent is launched and signed in, quota policy for tests. |
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
| [08 Match the design lab](superpowers/plans/2026-11-18-08-design-lab.md): the Chats screens as the lab (its CSS, avatars, brain popover, side panel); a quiet chat | Done |
| [09 ion chief and the Ions screen](superpowers/plans/2026-11-18-09-ion-chief.md): a project ion per project and ion chief over them; message any ion; questions in ion threads go through the project's ion (answers from your decisions, holds duplicates, suggests "always", flags failing decisions); `default` has no ion; plus the user's app fixes (no spinners, closed panel, files changed, rename and archive, a sidebar that scales) | Done |
| [10 Routines and Activity](routines.md): routines kept in your config per project, run by the daemon as ion threads (once per slot, a missed one once at start, pause all); the Activity page and an ion's Routines in Settings; `ion routines` | Done |
| 10 Artifacts, Tools | Not written |
| 11 Suggestions: ion chief suggests a routine for what you asked a project for on 3 days, and resuming a chat of yours that stalled with changes; cards in its chat (Add routine or Resume / Not now / fewer like this), `ion suggestions` | Done |
| 12 More adapters: Codex (through its app-server, not ACP) | Codex done; Cursor and Gemini CLI not started (not installed to verify) |
| 13 Ions that read like people: thread lines and a side panel, a frame around the app, plain-word reports, ready agents only (PR #19) | In review |
| [14 Ions with tools](superpowers/plans/2026-11-19-14-ions-with-tools.md): ions think as agent sessions with ion's tools and reading only; project profiles; ion chief routes among 20+ projects and asks which one when unsure | Done |
| [15 Workspace artifacts and processes](superpowers/plans/2026-11-19-15-workspace-artifacts-processes.md): the panel lists a chat's artifacts and every process its tool calls left running, wherever | Planned |
| [16 Prompt queue](superpowers/plans/2026-11-19-16-prompt-queue.md): queue your next messages while a chat's agent or an ion works (Enter queues, ⌘Enter sends now, Esc twice stops, ions too); Send now, Edit, Remove | Planned |

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
| `@ion/adapter-codex` | `packages/adapters/codex/README.md` |
| `@ion/adapter-fake` | `packages/adapters/fake/README.md` |
| `@ion/health` | Code-health ratchet: see "Code health" in `AGENTS.md`; baseline in `health/baseline.json` |
