# @ion/policy

ion's pure rules: no I/O, nothing but `@ion/schema`'s types.

- `pickAgent(candidates, task)` → `{ agent, reason }`: the agent a chat goes on when you picked none, and why, in one
  line ("On Codex — Claude Code is near its limit"). Your pick always wins; a limited agent is never picked; then
  fit, your agent order, headroom and billing.
