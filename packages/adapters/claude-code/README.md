# @ion/adapter-claude-code

Drives Claude Code through the Claude Agent SDK (`query()`), using the `claude` binary on your PATH.

## Sign-in

- ion uses Claude Code's **own login only**. It removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and the
  Bedrock/Vertex/Foundry switches from the environment it gives `claude`, and only `claude.ai` or `oauth_token`
  sign-ins count (`claude auth status --json`; ion reads `loggedIn` and `authMethod`, never account details).
- Not signed in → `Claude Code isn't signed in. Run: claude auth login`.
- Open question before shipping to other people: Anthropic's Agent SDK terms on third-party products offering
  claude.ai login. See `docs/superpowers/plans/2026-11-17-02-adapters.md`.

## Safety

- Only your **user** settings load (`settingSources: ["user"]`): a repo's `.claude/` can't pre-approve tools or run
  hooks. The project's `CLAUDE.md` is passed as instructions instead, read safely (no symlinks or hardlinks, inside
  the project, ≤ 64 KB, non-blocking, inside `<project-instructions>` markers).
- Every permission prompt goes to the daemon's `decide()`. "Always allow" never writes Claude Code's own rules.

## Events

`map.ts` turns SDK messages into ion events: `system/init` → `run.started`; text/thinking deltas (batched every
50 ms or 2 KB); `tool_use` → `tool.started`; `tool_result` → `tool.finished` (+ `file.changed` for edits);
`result` → `usage.reported` + `run.finished`.

## Transcripts

Real sessions recorded with `node scripts/record.mjs <name> <allow|deny> "<prompt>"` (Haiku, manual only) live in
`fixtures/transcripts/claude-code/<cli-version>/`; `transcripts.test.ts` replays them against goldens in `golden/`.
The recorder drops hook output and redacts paths. Live tests: `ION_LIVE_CLAUDE=1` (uses your Claude quota).
