# @ion/daemon

The always-on service that owns all state.

- `src/store`: the event log. The only code that writes SQLite. `EventStore.append` validates the event,
  assigns its per-run `seq` (gapless from 1), ignores a repeated `id`, updates every view in the same
  transaction, then notifies subscribers.
- `src/views`: tables updated as each event is appended (`runs`, `chats`, `needs`). `EventStore.rebuildViews()` replays the
  log into them; replay must give the same rows.
- `src/workspace`: git worktrees, one per chat, at `<data>/worktrees/<chatId>` on branch `ion/<slug>-<hash>`.
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
  by rule; read-only commands that stay in the worktree are allowed; anything else goes to a judge, a quick model on
  `ion.quick` with no tools, which answers allow or deny with a reason (deny on failure or after 30 s). One judge call
  per action and request in a chat. Limitation: Grok Build runs its own read-only commands (`cat`, `ls`, `grep`…)
  without asking anyone, so in Auto it can still read files ion would deny.
- `src/needs`: questions only you can answer (`need.raised`, answered once with `ion needs allow|deny <id>`;
  stopping or a crash supersedes a run's open needs). Permissions no longer raise needs (see access).
- `src/scheduler`: the run queue. At most `resources.max_runs` runs at once (`"auto"` = half the cores, at
  least one); each run stores `run.queued`, then starts when a slot frees.
- `src/views` also keep `messages` (yours and the agents', with full-text search) and `memory`. Each view has a
  version: when it changes, an existing database drops that view and rebuilds it from the log.
- Continuing a chat: a run resumes the chat's last harness session; when the harness can't, a new session gets the
  chat's earlier messages (newest 24,000 characters) as a labelled data block before your message.
- `src/mcp`: ion's MCP server at `/mcp` on the daemon's port. Each run gets its own key (kept only as a hash,
  revoked when the run ends) that sees its own project: `chat_history`, `search_chats`, `open_needs`, `memory_list`,
  `memory_write` (5 per run). Any `Origin` header is refused. ion's own tools are allowed by exact name; other MCP
  tools ask.
- `src/memory`: memory is yours ("you", shown in every project) or one project's, never shared between projects.
- `src/api`: the WebSocket API (see `@ion/schema` `api.ts` for the protocol).
- `src/main.ts`: entry point. Takes the `daemon.lock` (an exclusive SQLite lock the OS releases if the process dies, so only one daemon per data dir), then writes `daemon.json` (`pid`, `port`, `token`, mode 0600).

Data dir: `$ION_HOME/data`, else `$XDG_DATA_HOME/ion`, else `~/.local/share/ion`. Database: `ion.db`.
