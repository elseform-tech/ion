# @ion/desktop

ion's desktop app: Tauri 2 with React, TypeScript and Vite. It only displays state. Everything comes from the daemon
through `@ion/client/browser`, and it keeps nothing of its own (lint: no `node:*`, `fetch` or storage in `src`).

- `src-tauri/`: the shell. Its one command, `daemon_info`, reads the daemon's port and token from `daemon.json`
  (`$ION_HOME/data`, else `$XDG_DATA_HOME/ion`, else `~/.local/share/ion`). Core permissions only: no shell, no
  file system. The CSP allows `ws://127.0.0.1:*` and nothing remote; fonts are bundled.
- `src/connection.ts`: connects, shows "ion isn't running" while the daemon is down, tries again every 2 s, and
  reconnects when ion restarts (new port and token).
- `src/chats/`: the Chats screen.
  - `timeline.ts` turns a chat's events into what it shows (pure, tested).
  - `live.ts` keeps the sidebar's lists live (Needs you, Running, Chats).
  - `Composer` holds the agent, model, effort and access pickers.
  - `QuestionBar` shows a question as a card: the question, why, each option with its reasoning and tradeoffs (the
    recommended one marked), your own answer, and "Always for this project". ion's own question about a call it
    stopped says when ion went on without your answer.
  - `ChangesPanel` shows what the chat changed (`chat.diff`).
- Agents' text is Markdown with no raw HTML; links show where they point but open nothing.

Run it:

```sh
ion daemon start
pnpm --filter @ion/desktop tauri dev       # the app (needs Rust)
pnpm --filter @ion/desktop dev             # or the UI alone in a browser, dev builds only:
                                           # http://127.0.0.1:5173/?port=<port>&token=<token> (from daemon.json)
```

Tests: `pnpm vitest run apps/desktop` (React parts run in jsdom), `cargo test` in `src-tauri`.
