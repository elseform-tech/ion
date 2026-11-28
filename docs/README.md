# ion docs index

| Doc | What it's for |
|---|---|
| [design/ion-design-lab.html](design/ion-design-lab.html) | The product spec: screens, design system, architecture, engineering, CLI (canvas v34). Open in a browser. Since Plan 06: approvals (the approval bar, allow/deny) are replaced by agents' questions (Needs you, answered by choice), and every chat has a project, so "Plain chat" means a chat in `default`. Since Plan 09: the sidebar's project groups (star to keep a project open, "N more", rename and archive), shimmer instead of spinners, the changed-files box, the question box above a locked composer. |
| [architecture/contract.md](architecture/contract.md) | Event envelope and types, adapter interface, retries, import walls. |
| [tools.md](tools.md) | Tools (Plan 18): `mcp.json` and consent, keys in the keychain and tokens in the vault, OAuth sign-in, ion's gateway to your servers, agents bring their own tools ("Use its own tools", per agent; Settings → Tools shows them beside ion's), Import from your agents (`ION_AGENTS_HOME`), hooks (Auto-approval built in), skills, `ion mcp\|skills\|hooks` for agents (added off), and what ion refuses vs. only guesses ("ion is wary of this"). |
| [routines.md](routines.md) | Routines: where they live, the schedule format, how the daemon runs them, Activity, the CLI. |
| [research/acp-and-harnesses.md](research/acp-and-harnesses.md) | ACP protocol, Codex's app-server, how each coding agent is launched and signed in, quota policy for tests. |
| [research/memory-evals.md](research/memory-evals.md) | ion's memory on real agents: recall, precision, updates not copies, to-dos, Mark done, privacy, memory text that gives orders, and 300 files; how to run them and the latest numbers. |
| [research/judge-evals.md](research/judge-evals.md) | Auto's judge on real models: 59 labelled cases, how to run them, dangerous allowed / ordinary refused / unsure / latency. |
| [research/sandbox.md](research/sandbox.md) | Agents in the OS sandbox, away from ion's own files: each agent's real behaviour (Claude Code, Codex, opencode, Grok), Seatbelt and bubblewrap, nesting, what's covered and what isn't. |
| [research/usage-signals.md](research/usage-signals.md) | What each agent reports about its usage and limits (Codex's windows, Claude's rate-limit info, opencode's quota line, Grok's cost), with sources, and how ion uses it. |
| [research/skills.md](research/skills.md) | Skills through the Agent SDK's `plugins`: the live probe, and what ion passes to Claude Code. |
| [research/first-run.md](research/first-run.md) | What a beginner meets in ion today (Plan 21): opening ion to a first answer on opencode, Grok and no agent, in the app and the CLI; the defaults; the concept words; local usage counts; findings worst first; before and after Plan 21 (Task 6: the beginner path checked end to end). |
| [../scripts/tour.sh](../scripts/tour.sh) | The UX tour: a fresh ion with every chat and Tools state, a fake agents home for Import and Skills (`ION_TOUR_HOME`, `ION_TOUR_APP`); `tour.sh fresh` (`fresh none`): a brand-new ion for the first run. |
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
| [17 Settings](superpowers/plans/2026-11-19-17-settings.md): General (chats at once), Notifications (how loud, daily briefing, quiet hours, each project's level) and Shortcuts; ion notifies you through the system and briefs you each morning | In progress |
| [18 Tools](superpowers/plans/2026-11-20-18-tools.md): Settings → Tools: Connections (MCP servers from your mcp.json, signed in with OAuth, a key or their own login; ion is the gateway), Hooks (every ion event; Auto-approval built in) and Skills (your agents' own, Claude Code's on or off); General loses Default access. See [tools.md](tools.md) | PR A merged; PR B (Tasks 10–14: "/" and "@", agents' own tools, the OS sandbox, Auto like the agents, Remember) verified live in Task 11 |
| [19 Memory as files](superpowers/plans/2026-11-21-19-memory-files.md): ion's memory becomes small Markdown files, one topic each, for you or a project (to-dos too); chats and ions find them through a quick index and read details on demand; you can read and fix every file. Settings → Memory (between Ions and Tools): yours and each project's, search, who changed each and when, a file's text with Open, History (Restore) and Forget, Shared with chats, Keep for a chat's suggestion, Open memory folder, a line per broken file; To-dos (ion chief's screen shows how many are open) | In progress |
| [20 Usage-aware agents](superpowers/plans/2026-11-21-20-usage-aware-routing.md): ion knows how much each agent has used and has left and how it bills, picks a thread's agent with that in mind (saying why in one line), and offers to hand work to another agent when one hits its limit. As built: a usage line per agent in Settings → Agents and `ion status` ("62% of 5 h · resets 14:20", "limited until 16:00", "Free", "Learned from errors", this week's cost when paid per use); at a limit ion asks Continue on another agent, Wait for the reset, or Always continue here (Settings: Ask, Continue on the next agent, or Wait); an agent order used by handoffs, new chats and Pick by usage (off at first); "Chats ion runs at once" counts only ion's own chats; estimates from your past chats ("usually 31k–42k tokens"). Since PR #36 (2026-11-24): two model settings, "Ions think with" (the strongest model you're signed in to, or your pick) and "Chats ions start run on" (Automatic, or your pick); your own chats are set in the composer; Pick by usage is how Automatic always works; your chats ask at a limit, chats ions start go on another agent; the agent order is "Prefer in this order" under More | Done (PR pending) |

## Packages

| Package | Docs |
|---|---|
| `@ion/schema` | `packages/schema/README.md` |
| `@ion/config` | `packages/config/README.md` |
| `@ion/policy` | `packages/policy/README.md` |
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
