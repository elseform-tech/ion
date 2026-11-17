# @ion/adapter-fake

A scripted harness for tests; no model, no network. The prompt's first word picks a scenario:

| Prompt | What happens |
|---|---|
| `hello` (or anything else) | A short answer |
| `edit` | Reads a file, writes `notes.md`, reports `file.changed` |
| `approve` | Asks to write `notes.md`; on deny the tool fails and nothing changes |
| `fail` | `error { code: "crash" }`, then `failed` |
| `slow` | A 30-second command, for testing interrupt |

The daemon only loads it when `ION_ALLOW_FAKE=1`.
