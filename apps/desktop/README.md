# @ion/desktop

ion's desktop app: Tauri 2 with React, TypeScript and Vite. It only displays state. Everything comes from the daemon
through `@ion/client/browser`, and it keeps nothing of its own (lint: no `node:*`, `fetch` or storage in `src`).

- `src-tauri/`: the shell. Its one command, `daemon_info`, reads the daemon's port and token from `daemon.json`
  (`$ION_HOME/data`, else `$XDG_DATA_HOME/ion`, else `~/.local/share/ion`). Core permissions only: no shell, no
  file system. The CSP allows `ws://127.0.0.1:*` and nothing remote; fonts are bundled.
- `src/connection.ts`: connects, shows "ion isn't running" while the daemon is down, tries again every 2 s, and
  reconnects when ion restarts (new port and token).
- `src/chats/`: the Chats screen, drawn with the design lab's own CSS and markup (`@ion/design-system/lab.css`).
  - `timeline.ts` (with `steps.ts`) turns a chat's events into what it shows (pure, tested).
  - `live.ts` keeps the sidebar's lists live; `Sidebar` and `ProjectMenu` are the lab's sidebar (Needs you,
    Running, Chats by last activity, a project filter).
  - `ChatView` and `Work` are the conversation: your messages, each turn's work as one "Worked for" block (thinking
    and tool steps, each opening to its input and output), replies, and code blocks (`CodeBlock`). A quiet chat:
    errors and denials are single muted lines, and a retry counts down.
  - `Composer` is the lab's message box with the brain pill and popover (`BrainPopover`: harness, model, effort;
    ⌘. cycles effort), the access pick, and a new chat's project.
  - `QuestionBar` is one line: the question and a button per option. Its chevron opens why, each option's reasoning,
    your own answer and "Always for this project".
  - `ToolsPanel` is the side panel: Changes (`chat.diff`, numbered by `diffLines`) and Files. A chat in `default`
    opens with it closed (the toggle opens it); below 1100 px it starts closed.
- Left out of the lab until ion does them: Library, attachments, Preview, Terminal and Viewer tabs, Open in editor,
  Share, the Ions, Settings and Search rail buttons, and temporary chats.
- Agents' text is Markdown with no raw HTML; links show where they point but open nothing.

Run it:

```sh
ion daemon start
pnpm --filter @ion/desktop tauri dev       # the app (needs Rust)
pnpm --filter @ion/desktop dev             # or the UI alone in a browser, dev builds only:
                                           # http://127.0.0.1:5173/?port=<port>&token=<token> (from daemon.json)
```

Tests: `pnpm vitest run apps/desktop` (React parts run in jsdom), `cargo test` in `src-tauri`.
