# @ion/cli

The `ion` command. Talks to the daemon through `@ion/client`; never imports daemon code.

| Command | Output |
|---|---|
| `ion daemon start` | `Started`, or `Already running` |
| `ion daemon stop` | `Stopped`, or `Not running` |
| `ion daemon status` | `Running · pid … · port …` |
| `ion status` | `ion is running · 2 projects` |
| `ion projects ls` | `<id>  <path>` per line |
| `ion projects add <path>` | `Added <id>` |
| `ion projects new <name>` | Makes `~/ion/projects/<name>` (`[folders] projects`) as a git repo and adds it: `Created <id> at <path>` |
| `ion ask "<text>" [-p <project>] [--harness claude-code\|grok-build\|opencode] [--model m] [--effort e] [--access auto\|full]` | Runs in the chat's own worktree and streams it (no `-p`: the `default` project, made the first time); `--chat <id>` continues a chat with its history; shows `· Allowed by ion: …` / `· Denied by ion: … — reason` (Auto) and `· Retrying in 4s (…)`; ends `Done · 4.2s · $0.0031`, `Failed: …` or `Stopped` (Ctrl+C) |
| `ion projects access <id> auto\|full` | The project's access mode: Auto (ion decides) or Full access |
| `ion needs` | Agents' questions waiting on you: `<id>  <project>  <question>`, then its numbered choices |
| `ion answer <id> <n> [--always project\|everywhere]` | Picks choice `n`; it goes back into the chat as the next message. `--always` keeps it as a decision ion may answer from later (default: this chat only) |
| `ion decisions [ls] [-p <project>]` | Your decisions and what came of them |
| `ion decisions note <id> <text>` / `forget <id>` | Add what happened / forget it |
| `ion chats` | `<id>  <title>  <project>  <branch>  <last status>` (archived chats hidden) |
| `ion chats archive <id>` | Removes the chat's worktree; its branch stays |
| `ion memory ls [-p <project>]` | What ion remembers: yours, and the project's |
| `ion memory forget <id>` | Forget it |
| `ion harnesses` | Each coding agent, whether it's ready, and its own models |

Add `--json` to any command for machine output. Exit codes: `0` ok, `1` error, `2` ion isn't running, `130` stopped with Ctrl+C.
Set `ION_HOME` to use a separate config and data folder (the tests do).
