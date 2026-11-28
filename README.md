# ion

An open-source orchestrator for coding agents. Bring your own subscriptions (Claude Code, Codex, Grok Build,
Gemini CLI, Cursor CLI, Pi); ion runs them on your machine, one ion per project, with one place for
everything that needs you.

Status: early. Working: daemon, event log, config, architecture lint rules, CI, and `ion ask` on Claude Code,
Grok Build and opencode. Each chat works in its own git worktree; anything outside it waits for you
(`ion questions`); runs queue and retry.

## Quick start (development)

```sh
pnpm install
pnpm build
node apps/cli/dist/index.js daemon start
node apps/cli/dist/index.js status
node apps/cli/dist/index.js projects add ~/code/my-app
node apps/cli/dist/index.js ask "Explain the build" -p my-app --agent opencode
```

The desktop app doesn't include ion yet: a packaged build can't start ion and says so. Build ion as above and
start it (`daemon start`); a development build of the app (`pnpm --filter @ion/desktop tauri dev`) starts it for you.

## Docs

See [docs/README.md](docs/README.md) for the index: design canvas, architecture contract, plans.

## License

Apache-2.0
