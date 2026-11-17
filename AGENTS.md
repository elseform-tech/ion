# Working on ion

For humans and AI agents. Read `docs/architecture/contract.md` first.

## Layout

| Path | What |
|---|---|
| `packages/schema` | The contract: event envelope, event types, capabilities, wire protocol. Imports nothing. |
| `packages/config` | Config files and paths (`config.toml`, projects). |
| `packages/client` | Typed WebSocket client for the CLI and the desktop app. |
| `apps/daemon` | Owns all state. `src/store` is the only SQLite writer; `src/views` are tables updated per event. |
| `apps/cli` | The `ion` command. |
| `tools/lint-rules` | Custom ESLint rules that enforce the walls below (`ion/walls`, `ion/event-types-from-schema`, `ion/no-direct-db`, `ion/no-child-process`). |

## Walls

| Package | May import | Never |
|---|---|---|
| `apps/desktop` | `client`, `schema`, `design-system` | `daemon`, adapters, `node:*` |
| `apps/cli` | `client`, `schema`, `config` | `daemon`, adapters |
| `apps/daemon` | `schema`, `config`, `policy`, `adapter-kit`, adapters via registry | `desktop`, `design-system` |
| `packages/adapters/*` | `schema`, `adapter-kit` | `daemon`, other adapters |
| `packages/policy` | `schema` | anything doing I/O |
| `packages/schema` | nothing | everything |

Also enforced: event type strings only in `packages/schema` (use `EV.*`); SQLite only in `apps/daemon/src/store`;
child processes only in `apps/daemon/src/workspace`, adapters and `apps/cli/src/daemon-control.ts`.

## Rules

- Test first. Every bug fix adds a test named `regression/<issue>-<slug>.test.ts`.
- No real model calls in tests.
- UI and CLI copy: short, plain words, no jargon, no explanatory hints.
- Before committing: `pnpm check && pnpm build`.
- Keep `docs/README.md` (the index) and this file current when you add a package or a doc.
