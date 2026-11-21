# @ion/daemon

The always-on service that owns all state.

- `src/store`: the event log. The only code that writes SQLite. `EventStore.append` validates the event,
  assigns its per-run `seq` (gapless from 1), ignores a repeated `id`, updates every view in the same
  transaction, then notifies subscribers.
- `src/views`: tables updated as each event is appended (`runs`, `chats`, `needs`). `EventStore.rebuildViews()` replays the
  log into them; replay must give the same rows.
- `src/workspace`: projects by name (`<[folders] projects>/<name>`, default `~/ion/projects`, a new git repo
  with one empty commit; `default` is made the first time a chat has no project). Git worktrees, one per chat, at `<data>/worktrees/<chatId>` on branch `ion/<slug>-<hash>`.
  The only code that runs `git`: no shell, no prompts, a minimal environment, the repo's hooks and
  `core.fsmonitor` turned off. Archiving a chat removes its worktree and keeps the branch.
- `src/runs`: starts runs in the chat's worktree. The policy allows reads, searches and edits inside it
  (except git internals, dot-folders and tool config files); anything else goes by the access mode.
  Retries: transient failures back off with full jitter (`random(0, min(120, 2 × 2^attempt))` s, at most 4
  tries, a harness retry-after wins); a real failure gets one retry at the next effort level.
- `src/access` and `src/runs/approvals.ts`: every permission request outside the chat's worktree goes by the run's
  access mode (`ion ask --access`, else the project's `access`, else `[access] default`, which is `"auto"`).
  **Full access** allows it. **Auto** never pauses: your secrets (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, gh,
  gcloud, 1Password, `.netrc`, `.git-credentials`, `.npmrc`, `.pypirc`, Keychains) and ion's own files are denied
  by rule; read-only commands whose arguments are plain relative paths inside the worktree are allowed; anything else goes to a judge, `[access] judge` (default `claude-code:haiku`, a bare session
  with no tools), which answers allow or deny with a reason (deny on failure or after 30 s). One judge call
  per action and request in a chat. The judge also gets your decisions that apply (newest 10). When the judge
  says no (or can't decide), ion asks you instead: Allow or Don't allow (Remember keeps either for that exact action in the project), or your
  own words. The tool call waits up to 4 minutes (agents' hooks wait 5); with no answer ion says no, the agent goes
  on, and the question stays open: a later yes still counts and the agent is told. A rule's no (your secrets,
  ion's files) never asks.
- `src/gate`: every tool call, before it runs, through each harness's own hook: `POST /gate/<key>` on the daemon's
  port (a key per run, separate from MCP keys; no `Origin`), answered `{decision, reason?}` by the same path as
  permission prompts. Claude Code: an SDK `PreToolUse` callback. Grok: `~/.grok/hooks/ion-gate.json` (a command
  hook that does nothing outside ion's runs; folder trust stays on), which Auto never lets an agent touch. opencode: ion's
  plugin through `OPENCODE_CONFIG_CONTENT`. Every hook fails closed. Only Auto's decisions are stored; a gate allow
  answers the harness's own prompt for the same command or file within 2 s, so it isn't decided twice.
- `src/needs` and `src/decisions`: agents' questions. Every run with ion's tools is told (`runs/instructions.ts`;
  Claude's system prompt, a marked first block of each ACP turn) to ask only through ion's `ask` tool; each agent's
  own question card is off (Claude's `AskUserQuestion`, Grok's `ask_user_question`), since nobody can answer it
  here. An agent calls `ask` (2–4 choices, each with what it leads to) and ends its turn; the question waits under Needs you, and outlives its run. Your answer
  (`ion answer`) is stored as a decision (this chat, this project or everywhere) and sent into the chat as the next
  message; the run that follows records the decision's outcome (ran or failed); agents (`report_outcome`, 3 per
  run) and you (`ion decisions note`) add notes. ion answers a new question itself only from a project or
  everywhere decision, when a quick model names one of the new question's own choices exactly.
- `src/scheduler`: the run queue. At most `resources.max_runs` runs at once (`"auto"` = half the cores, at
  least one); each run stores `run.queued`, then starts when a slot frees.
- `src/views` also keep `messages` (yours and the agents', with full-text search), `memory` and `decisions`. Each view has a
  version: when it changes, an existing database drops that view and rebuilds it from the log.
- Continuing a chat: a run resumes the chat's last harness session; when the harness can't, a new session gets the
  chat's earlier messages (newest 24,000 characters) as a labelled data block before your message.
- `src/mcp`: ion's MCP server at `/mcp` on the daemon's port. Each run gets its own key (kept only as a hash,
  revoked when the run ends) that sees its own project: `chat_history`, `search_chats`, `open_needs`, `memory_list`,
  `memory_write` (5 per run), `ask`, `decisions`, `report_outcome`. Any `Origin` header is refused. ion's own tools are allowed by exact name; other MCP
  tools ask.
- `src/memory`: memory is yours ("you", shown in every project) or one project's, never shared between projects.
- `src/api`: the WebSocket API (see `@ion/schema` `api.ts` for the protocol).
- `src/main.ts`: entry point. Takes the `daemon.lock` (an exclusive SQLite lock the OS releases if the process dies, so only one daemon per data dir), then writes `daemon.json` (`pid`, `port`, `token`, mode 0600).

Data dir: `$ION_HOME/data`, else `$XDG_DATA_HOME/ion`, else `~/.local/share/ion`. Database: `ion.db`.

## Ions (Plan 09)

`src/ions/`: every project but `default` has an ion, and ion chief sits over them. Each ion's chat is its events
on `ion:<ionId>` (`ion.heard`, `ion.said`).
- A project's ion starts a thread (a chat with `by: "ion"`, always in Auto access) for what you ask and says how it
  ended.
- ion chief decides on the quick model (the judge's): it answers from the state of your projects (never one with
  `shareWithIon = false`), or sends your message on to up to 5 project ions.
- Questions in ion threads go through the project's ion (`questions.ts`): an answer from your decisions there, a
  duplicate held behind the same question waiting (settled only when identical), else your question with the
  ion's note; "always?" after the same answer three times; a decision whose runs failed twice is flagged.

## Routines (Plan 10)

`src/scheduler/routines.ts`: each project's routines (in your config) run when they're due, as a thread their ion
starts (`Ions.routine`: Auto, `by: "ion"`, titled by the routine's name, briefed with its text, at its effort). It
looks at start and once a minute. Every slot handled is a `routine.ran` event, so a slot runs at most once, across
restarts too; slots missed while ion was stopped run once, as the latest. Off, or with pause all on, a routine's slots
pass; turned on again it waits for its next one. `src/scheduler/activity.ts` builds `activity.list`; the commands
are in `src/api/routines.ts`. See `docs/routines.md`.

## Suggestions (Plan 11)

`src/ions/suggestions.ts`: ion chief looks at start and then hourly, and suggests in its chat (`ion:chief`):
- a routine, when you asked a project (its ion, or a chat you started there) for the same thing on 3 different days
  in the last four weeks (`habits.ts`: your words lowercased, without dates and punctuation; its time is their one
  weekday, else daily, at their median time to the half hour). Never for `default`, a project with
  `shareWithIon = false`, or what a routine there already does. Taking it adds the routine as `routine.add` does.
- resuming a chat of yours whose last run failed or was stopped, untouched for 3 days, with changes in its worktree.
  Taking it sends "Pick up where you left off." through the normal ask, on the chat's own agent. Touched again and
  stalled again, it can come back once more.

Each suggestion is an `ion.said` card and each answer a `suggestion.answered`, read back by
`src/views/suggestions.ts` (`suggestionsView`, and `asksView`: what you asked per project), so after a restart it
never offers the same one twice. "Fewer like this" (`mute`) stops that kind for that project.
