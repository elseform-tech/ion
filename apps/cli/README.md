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
| `ion ask "<text>" -p <project> [--harness claude-code\|grok-build\|opencode] [--model m] [--effort e] [--access auto\|full]` | Runs in the chat's own worktree and streams it; `--chat <id>` continues a chat with its history; shows `· Allowed by ion: …` / `· Denied by ion: … — reason` (Auto) and `· Retrying in 4s (…)`; ends `Done · 4.2s · $0.0031`, `Failed: …` or `Stopped` (Ctrl+C) |
| `ion projects access <id> auto\|full` | The project's access mode: Auto (ion decides) or Full access |
| `ion needs` | What's waiting on you: `<id>  <project>  <summary>` |
| `ion needs allow\|deny <id>` | Answer it; the paused run resumes |
| `ion chats` | `<id>  <title>  <project>  <branch>  <last status>` (archived chats hidden) |
| `ion chats archive <id>` | Removes the chat's worktree; its branch stays |
| `ion memory ls [-p <project>]` | What ion remembers: yours, and the project's |
| `ion memory forget <id>` | Forget it |
| `ion harnesses` | Each coding agent, whether it's ready, and its own models |

Add `--json` to any command for machine output. Exit codes: `0` ok, `1` error, `2` ion isn't running, `130` stopped with Ctrl+C.
Set `ION_HOME` to use a separate config and data folder (the tests do).
