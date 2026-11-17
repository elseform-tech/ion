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

Add `--json` to any command for machine output. Exit codes: `0` ok, `1` error, `2` ion isn't running.
Set `ION_HOME` to use a separate config and data folder (the tests do).
