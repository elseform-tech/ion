# ion

An open-source orchestrator for coding agents. Bring your own subscriptions (Claude Code, Codex, Grok Build,
Gemini CLI, Cursor CLI, Pi); ion runs them on your machine, one ion per project, with one place for
everything that needs you.

Status: early. The foundation is in: daemon, event log, config, `ion` CLI, architecture lint rules, CI.

## Quick start (development)

```sh
pnpm install
pnpm build
node apps/cli/dist/index.js daemon start
node apps/cli/dist/index.js status
```

## Docs

See [docs/README.md](docs/README.md) for the index: design canvas, architecture contract, plans.

## License

Apache-2.0
