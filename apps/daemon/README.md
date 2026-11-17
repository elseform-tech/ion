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
  (except git internals, dot-folders and tool config files, which ask); anything else is "ask".
  Retries: transient failures back off with full jitter (`random(0, min(120, 2 × 2^attempt))` s, at most 4
  tries, a harness retry-after wins); a real failure gets one retry at the next effort level.
- `src/needs`: an "ask" becomes a need (`need.raised`); the run waits for exactly one `need.resolved`
  (`ion needs allow|deny <id>`). Stopping, interrupting or a crash supersedes a run's open needs.
- `src/scheduler`: the run queue. At most `resources.max_runs` runs at once (`"auto"` = half the cores, at
  least one); each run stores `run.queued`, then starts when a slot frees.
- `src/api`: the WebSocket API (see `@ion/schema` `api.ts` for the protocol).
- `src/main.ts`: entry point. Takes the `daemon.lock` (an exclusive SQLite lock the OS releases if the process dies, so only one daemon per data dir), then writes `daemon.json` (`pid`, `port`, `token`, mode 0600).

Data dir: `$ION_HOME/data`, else `$XDG_DATA_HOME/ion`, else `~/.local/share/ion`. Database: `ion.db`.
