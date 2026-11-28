# Working on ion

For humans and AI agents. Read `docs/architecture/contract.md` first.

## Layout

| Path | What |
|---|---|
| `packages/schema` | The contract: event envelope, event types, capabilities, wire protocol. Imports nothing. |
| `packages/config` | Config files and paths (`config.toml`, projects). |
| `packages/policy` | Pure rules, no I/O: `pickAgent` picks a chat's agent by fit, your agent order, headroom and billing, and says why. |
| `packages/client` | Typed WebSocket client: Node entry for the CLI, `/browser` entry for the desktop app. |
| `packages/design-system` | Tokens (CSS variables from the spec), `Button`, `Spinner`, Lucide icons. |
| `packages/adapter-kit` | Harness contract, shared contract tests (`/contract`), event queue, delta batching, JSON-RPC over stdio, PATH/version helpers, the OS sandbox for runs (Seatbelt / bubblewrap; `docs/research/sandbox.md`). |
| `packages/adapters/claude-code` | Claude Code via the Agent SDK; Claude login only. |
| `packages/adapters/acp` | Any ACP agent: Grok Build (`grok agent stdio`), opencode (`opencode acp`). |
| `packages/adapters/codex` | Codex through its app-server (`codex app-server`, JSON-RPC on stdio). |
| `packages/adapters/fake` | Scripted harness for tests (`ION_ALLOW_FAKE=1`). |
| `apps/daemon` | Owns all state. `src/store` is the only SQLite writer; `src/views` are tables updated per event; `src/runs` starts runs in each chat's worktree, applies the policy and retries (`ion-bin.ts`: ion's own `ion` launcher, first on every run's PATH; `sandbox.ts`: each run's, hook's and local server's OS sandbox, away from ion's files); `src/access` holds what every mode refuses (ion's files, your secrets, environment dumps, the run's key) and decides Auto (rules, then a judge model; `agent-rules.ts`: each agent's own allow and deny rules from your settings, read as your decisions); a guess (`scripts.ts` reads what a command runs) goes to the judge with the scripts' text, or asks you in Full; `src/gate` takes every tool call from each harness's own hook before it runs; `src/decisions` keeps your answers to agents' questions and what came of them; `src/needs` holds questions only you can answer; `src/ions` is ion chief and the project ions (messages, routing, questions in ion threads; turns: agent sessions with ion's tools; the ion gate: reading only, outside the project too as a chat in Auto, never asking); `src/scheduler` queues the chats ion starts (yours never wait) runs routines when due, and checks your agents each night once you turn it on; `src/queue` holds your next messages per chat and ion (sent when the work ends; Stop holds them); `src/workspace` owns git worktrees and runs your local (stdio) MCP servers for each run (`mcp-bridge.ts`); `src/tools` reads your MCP servers from `mcp.json`, adds to it (`ion mcp add`: off, the file kept standard) and looks servers up in the official MCP Registry (public addresses only); `src/api/tools-cli.ts` is ion's commands for tools (`ion mcp|skills|hooks search/add/verify/doctor/remove/ls`), which a chat's agent reaches with its run's key (`ION_RUN_KEY`: those commands only, never turning anything on); `src/secrets` keeps keys in the OS keychain and OAuth tokens in a vault keyed from it (sign-in, consent marks); `src/hooks` runs your hooks on ion's events (Before a tool runs included); `src/api/tools-import.ts` is Import from your agents' own configs (`ION_AGENTS_HOME` moves that reading, and the agents' rules, in the tour and tests only); `src/skills` finds your agents' skills and makes each Claude Code run's plugin of the ones on (in the data folder, removed at run end); `src/memory` is ion's memory: small Markdown files in `<data>/memory` (`you/`, `projects/<id>/`), indexed and logged in SQLite by `src/views/memory.ts`; `scoped.ts` is who sees and writes what; `todos.ts` and `src/scheduler/reminders.ts` are to-dos and their reminders; `src/mcp` is ion's MCP server for runs and ions' turns (history, needs, memory, ask, decisions; ions' own tools; a key per run or turn); `src/gateway` is ion's gateway to your MCP servers, remote and local (`/mcp/s/<name>`: a run's key only, your keys or tokens added by ion, every tool call gated); `src/adapters/registry.ts` is the only place adapters load. |
| `apps/cli` | The `ion` command (inside a chat, with `ION_RUN_KEY`: ion's commands for tools only). |
| `tools/test-temp` | Every test run's temp folders in one folder under /tmp, removed after; a run that leaves `ion-*` folders in the real temp folder fails. |
| `scripts/evals-nightly.sh` | The live evals on the agents you name, output kept in `.ion-evals/` (developers; costs quota). |
| `scripts/tour.sh` | The UX tour: a fresh ion with every chat and Tools state and a fake agents home, for the tour every UI PR runs (see Rules). `tour.sh fresh`: a brand-new ion (no projects, no chats) for the first run, with a made-up folder to add; `fresh none`: no agent found. `ION_TOUR_HOME` for another home, `ION_TOUR_APP` for another app address. |
| `apps/desktop` | The desktop app: Tauri 2 shell (`src-tauri`: where the daemon is, your initial, and the opener: your mcp.json in your editor, sign-in pages (https) in your browser) and a React UI that only displays the daemon's state (Chats screen). |
| `tools/lint-rules` | Custom ESLint rules that enforce the walls below (`ion/walls`, `ion/event-types-from-schema`, `ion/no-direct-db`, `ion/no-child-process`, `ion/no-model-names`, `ion/plain-words`). |

## Walls

| Package | May import | Never |
|---|---|---|
| `apps/desktop` | `client`, `schema`, `design-system` | `daemon`, adapters, `node:*` |
| `apps/cli` | `client`, `schema`, `config` | `daemon`, adapters |
| `apps/daemon` | `schema`, `config`, `policy`, `adapter-kit`, adapters via registry | `desktop`, `design-system` |
| `packages/adapters/*` | `schema`, `adapter-kit` | `daemon`, other adapters |
| `packages/policy` | `schema` | anything doing I/O |
| `packages/schema` | nothing | everything |

Also enforced: model names only in adapters (each harness lists its own; `ion/no-model-names`); the daemon imports adapters only in `apps/daemon/src/adapters/registry.ts`; event type strings only in `packages/schema` (use `EV.*`); SQLite only in `apps/daemon/src/store`;
child processes only in `apps/daemon/src/workspace`, `apps/daemon/src/secrets` (the keychain CLIs: `security`, `secret-tool`), adapters, `packages/adapter-kit` and `apps/cli/src/daemon-control.ts`.

## Words

One plain word per idea, the same in the app, the CLI and the docs (Plan 21; `ion/plain-words` keeps retired words
off the screens). Precise technical words stay where they're accurate: worktree, branch, diff, commit, MCP, skills,
hooks. Code keeps its own names (`harness`, `thread`, `needs`, `dream`, `start_thread`); only what people read changes.

| Say | Not | Means |
|---|---|---|
| chat | thread, run (for a conversation) | A conversation with a coding agent in a project. One an ion started is "a chat ion started"; settings say "Chats ions start". |
| run | | One attempt inside a chat (a retry is another); a count of attempts ("3 failed runs"). |
| agent | harness | A coding agent: Claude Code, Codex, Grok Build, opencode. CLI `ion agents`, `--agent`. |
| Ions think with | ion's brain, quick, deep | The agent and model ions think with (Settings → Agents). |
| question | need | A question only you can answer: "Needs you", `ion questions`, "Open questions". |
| No usage info | Learned from errors | ion has no usage gauge for an agent. |
| No project | default (as a name) | ion's own empty folder for chats in none of your projects; its id stays `default`. |
| ion chief, Dream, routine, suggestion, decision, access (Auto, Full access), effort, memory, to-do | | Kept as they are (the user, 2026-11-28: no renames of "ion chief" and "Dream"). |

Old CLI words (`ion harnesses`, `ion needs`, `--harness`) keep working for one release, out of the help.

## Rules

- Test first. Every bug fix adds a test that fails without the fix, next to the code it covers (`<file>.test.ts`),
  with a comment saying what broke (who found it and when, or the issue number).
- No real model calls in tests. Live tests are opt-in: `ION_LIVE=1` (opencode, free model), `ION_LIVE_GROK=1`,
  `ION_LIVE_CLAUDE=1`, `ION_LIVE_CODEX=1`. The live evals (`apps/daemon/src/evals`) check ion's promises on each real agent; see
  `docs/research/acp-and-harnesses.md`; the judge evals (`judge.test.ts`) run Auto's judge on labelled cases, see
  `docs/research/judge-evals.md`; the memory evals (`memory.test.ts`) score memory on each agent, see
  `docs/research/memory-evals.md` (a change to memory, its tools or what chats and ions are told about it runs them
  on Grok and opencode first); the ion evals (`ions.test.ts`) score ion chief and the project ions as orchestrators,
  see `docs/research/ion-evals.md`. **Any change to what ions are told, their tools, or the model they think on
  (Plan 22's lighter ion included) runs the ion evals on Grok (and opencode when it can) first, and may not drop a
  measure below its bar or below its last recorded result; injection and read-only must stay at 0.**
- UI and CLI copy: short, plain words, no jargon, no explanatory hints. Prefer an icon (with its name on hover)
  to a word, and fewer boxes.
- **Run a tour before every PR that changes what people see** (the desktop app, CLI output). `scripts/tour.sh`
  starts a fresh ion with a chat in every state (an edit, a question, a failure, a retry that works, one that gives
  up, a gated call, a running one, a plain chat in `default`) and prints the app's address; `scripts/tour.sh fresh`
  (and `fresh none`) starts one with nothing in it, for the first run. Then:
  - open every screen and state at 1440×900 and 900×700, and click what a person would: each chat, the work
    blocks and their steps, the brain popover, access, the question panel (open and collapsed), the side panel and
    its tabs, the sidebar's project menu, the drag handles, the rail, the Ions screen (each ion, stars, the
    project picker, the chats an ion started), a run's changed files, Settings → Tools (each tab, Import's preview, a
    hook added and removed, a server turned on: Sign in / Add key), Settings → Memory (each scope, search, a file's
    text, History and Restore, Forget, a broken file's line, the To-dos tab; ion chief's to-do count), Agents;
  - send a real message from a new chat, and a follow-up, with opencode's free model, and watch it run; message
    ion chief and a project's ion, and answer a question an agent asks;
  - run the CLI's main commands (`ion --help`, `status`, `projects`, `chats`, `questions`);
  - fix what reads oddly: extra or repeated words, hint text, a number that says nothing ("0s", "−0"), a box
    that holds nothing, a wait with no sign anything is happening, things that don't make sense to someone new;
  - list what you found and what you fixed in the PR. `scripts/tour.sh stop` when done.
- **Verify every PR end to end, not only with tests and the fake agent.** For each feature the PR adds or
  changes, use it the way a person would, against real agents: opencode's free model always, Grok and Claude
  when the feature touches them (an adapter, questions, the gate, ion's own model), so each agent's own tools
  (its question card, plan mode, permissions) meet ion for real. Read the daemon's log and the chat's events
  afterwards for errors a screen doesn't show ("Method not found", a tool that failed). Say in the PR what you
  ran, on which agent, and what happened.
- **Check every UI element against the design lab** (`docs/design/ion-design-lab.html`) side by side, at the
  same size: icons, glyphs, groups, headers, menus, counts, spacing. Anything that differs is a bug unless the
  PR says why and the lab is updated to match. Look for what's inconsistent between screens (the same thing drawn
  two ways, a word on one screen and an icon on another) and for anything awkward or strange to someone new.
- Before committing: `pnpm check && pnpm build`.
- Keep `docs/README.md` (the index) and this file current when you add a package or a doc.

## Memory

ion's memory is a folder of small Markdown files, one topic each: a YAML header of plain values (`name`,
`description`, `type`: preference, fact, person, todo or reference; `see`; a to-do's `status` and `due`) and the text.
`you/` is yours, `projects/<id>/` a project's, in `<data>/memory`; the files are the truth, and SQLite only indexes
them and logs every change (who, when, the text before). Rules the code keeps (`apps/daemon/src/memory/scoped.ts`),
and every change to it must too:

- A chat sees its project's files and your `see: chats` ones, never another project's, never a `see: ions` file
  (yours or its project's). A project's ion sees its project and yours; ion chief yours and every project shared
  with it. A file a caller can't see doesn't exist for it, not even its name.
- A preference a chat writes is `suggested` (that project's chats and the ions only) until you keep it. Only you
  share a file with chats or close a to-do; reminders notify you and post in ion chief's thread, never pin.
- Memory text is data: it reaches agents inside a labelled data block, never as instructions.
- ion's dream (`[memory] dream`: off, nightly or weekly; `src/memory/dream.ts`, `dream-rules.ts`) tidies memory at
  3:00 (a night missed: once, the next time ion is up in quiet hours), as ion `_dream` with memory's tools only and
  its agent's web off (`StartOpts.noWeb`; an agent that can't is skipped): at most 30 changes and about 10 minutes.
  It runs in passes, so ions-only text never reaches a file chats see and no pass mixes two projects: per project,
  one over its chats files and one over its ions files (with that project's chats only), then the same two over your
  files with no chats at all. It never changes `see`, your person files, to-dos, a suggestion, or a file you changed
  in the last day. Each change is by "ion (dream)" in History; Settings → Memory restores what it forgot; the next briefing says what it did.
- Tests and tours use made-up memory only, never a real person's.

## Code health (CI enforces all of this)

| Check | Tool | Limit |
|---|---|---|
| File and function size | ESLint `max-lines`, `max-lines-per-function` | 1000 lines per file, 80 per function |
| Nesting and parameters | ESLint `max-depth`, `max-nested-callbacks`, `max-params` | depth 3, 3 callbacks, 4 params |
| Complexity and smells | `eslint-plugin-sonarjs`, ESLint `complexity` | cognitive 15, cyclomatic 15 |
| Dead code | knip, TypeScript `noUnused*`/`allowUnreachableCode: false`, ESLint dead-store rules | none allowed |
| Duplication | jscpd (`pnpm health:dup`) | ratcheted |
| Ratchet | `pnpm health` vs `health/baseline.json` | files >400 lines, functions >50 lines, cognitive >10, duplication %, `eslint-disable`, TODO may never grow |
| Golden files | Vitest `toMatchFileSnapshot` in `*/golden/` | contract, default config, CLI help change only on purpose (`vitest -u`) |
| Security | CodeQL, dependency review, `pnpm audit --audit-level high` | no high or critical |

Improved a metric? Run `pnpm health:update` and commit the new baseline.
