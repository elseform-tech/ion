# @ion/adapter-acp

One adapter for every coding agent that speaks the Agent Client Protocol (ACP) over stdio.
Protocol notes: `docs/research/acp-and-harnesses.md`.

| Harness | Launch | Sign in |
|---|---|---|
| Grok Build (`GROK_BUILD`) | `grok agent stdio` | `grok login` |
| opencode (`OPENCODE`) | `opencode acp`, default model `opencode/big-pickle` (free) | `opencode auth login` |

- `auth.status()` opens a session without sending a prompt; `-32000` from the agent means signed out. No quota used.
- Model and effort are set through the session's config options (`category: "model"` / `"thought_level"`).
- Permission requests go to the daemon's `decide()`; ion picks the matching `allow_once` / `allow_always` / `reject_once` option.
- One agent process per turn; `interrupt()` sends `session/cancel`, then stops the process after 3 s.

Tests: the shared contract suite runs against `test/fake-agent.mjs`. Live (opt-in): `ION_LIVE=1` (opencode, free),
`ION_LIVE_GROK=1` (Grok Build, uses your Grok quota).
