# @ion/desktop

ion's desktop app: Tauri 2 with React, TypeScript and Vite. It only displays state. Everything comes from the daemon
through `@ion/client/browser`, and it keeps nothing of its own (lint: no `node:*`, `fetch` or storage in `src`).

- `src-tauri/`: the shell. `daemon_info` reads the daemon's port and token from `daemon.json`
  (`$ION_HOME/data`, else `$XDG_DATA_HOME/ion`, else `~/.local/share/ion`); `user_initial` gives the rail your
  initial. Core permissions, plus dragging the window by its header: no shell, no file system. The CSP allows
  `ws://127.0.0.1:*` and nothing remote; fonts are bundled.
- `src/connection.ts`: connects, shows "ion isn't running" while the daemon is down, tries again every 2 s, and
  reconnects when ion restarts (new port and token). A development build starts ion itself (Plan 21); the packaged
  app doesn't include ion yet, so a release build says so on that screen, with how to get ion (`Down.tsx`).
- `src/chats/`: the Chats screen, drawn with the design lab's own CSS and markup (`@ion/design-system/lab.css`).
  - `timeline.ts` (with `steps.ts`) turns a chat's events into what it shows (pure, tested).
  - `live.ts` keeps the sidebar's lists live; `Sidebar` and `ProjectMenu` are the lab's sidebar (Needs you,
    Running, Chats by last activity, a project filter).
  - `ChatView` and `Work` are the conversation: your messages, each turn's work as one "Worked for" block (thinking
    and tool steps, each opening to its input and output), replies, and code blocks (`CodeBlock`). A quiet chat:
    errors and denials are single muted lines, and a retry counts down.
  - `Composer` is the lab's message box with the brain pill and popover (`BrainPopover`: agent, model, effort;
    ⌘. cycles effort), the access pick, and a new chat's project.
  - `QuestionBar` is one box above the message box, open: the question, why, each option with its reasoning, your
    own answer and "Always for this project". It collapses to one line with a button per option. While it waits,
    the message box is locked.
  - `ToolsPanel` is the side panel: Changes (`chat.diff`, numbered by `diffLines`) and Files. It opens when a
    project chat has changed something; a plain chat (in `default`) keeps it closed; below 1100 px it lies over
    the conversation. `Resizer` lets you drag the sidebar's and the panel's widths; the conversation keeps 520 px.
  - The sidebar groups your chats by project, each row with the start of the agent's last reply and a mark when
    its last run failed or was stopped. The avatar slot stays empty for your chats: it marks chats ions started.
- `src/ions/`: the Ions screen (Plan 09). ion chief and each project's ion on the left (the project's colour on its
  agent's shape; ion chief's orbit), the open ion's chat on the right: your messages, its lines, the chats it
  started (a link, or the fan-out card for several), its "always?" suggestions, and what needs you pinned atop
  ion chief. Chats ions started show their ion in the sidebar's first slot; your own chats never do.
- Left out of the lab until ion does them: Library, attachments, Preview, Terminal and Viewer tabs, Open in editor,
  Share, the Ions, Settings and Search rail buttons, temporary chats, and a light theme (the lab is dark only).
- Agents' text is Markdown with no raw HTML; links show where they point but open nothing.

Run it:

```sh
ion daemon start
pnpm --filter @ion/desktop tauri dev       # the app (needs Rust)
pnpm --filter @ion/desktop dev             # or the UI alone in a browser, dev builds only:
                                           # http://127.0.0.1:5173/?port=<port>&token=<token> (from daemon.json)
```

Tests: `pnpm vitest run apps/desktop` (React parts run in jsdom), `cargo test` in `src-tauri`.
