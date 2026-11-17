# @ion/daemon

The always-on service that owns all state.

- `src/store`: the event log. The only code that writes SQLite. `EventStore.append` validates the event,
  assigns its per-run `seq` (gapless from 1), ignores a repeated `id`, updates every view in the same
  transaction, then notifies subscribers.
- `src/views`: tables updated as each event is appended (`runs`). `EventStore.rebuildViews()` replays the
  log into them; replay must give the same rows.
- `src/api`: the WebSocket API (see `@ion/schema` `api.ts` for the protocol).
- `src/main.ts`: entry point. Writes `daemon.json` (`pid`, `port`, `token`, mode 0600) to the data dir.

Data dir: `$ION_HOME/data`, else `$XDG_DATA_HOME/ion`, else `~/.local/share/ion`. Database: `ion.db`.
