# Working on ion

For humans and AI agents. Read `docs/architecture/contract.md` first.

## Layout

| Path | What |
|---|---|
| `packages/schema` | The contract: event envelope, event types, capabilities, wire protocol. Imports nothing. |
| `packages/config` | Config files and paths (`config.toml`, projects). |
| `packages/client` | Typed WebSocket client for the CLI and the desktop app. |
| `packages/adapter-kit` | Harness contract, shared contract tests (`/contract`), event queue, delta batching, PATH/version helpers. |
| `packages/adapters/claude-code` | Claude Code via the Agent SDK; Claude login only. |
| `packages/adapters/acp` | Any ACP agent: Grok Build (`grok agent stdio`), opencode (`opencode acp`). |
| `packages/adapters/fake` | Scripted harness for tests (`ION_ALLOW_FAKE=1`). |
| `apps/daemon` | Owns all state. `src/store` is the only SQLite writer; `src/views` are tables updated per event; `src/runs` starts runs in each chat's worktree, applies the policy and retries; `src/needs` turns "ask" into needs; `src/scheduler` queues runs; `src/workspace` owns git worktrees; `src/adapters/registry.ts` is the only place adapters load. |
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

Also enforced: the daemon imports adapters only in `apps/daemon/src/adapters/registry.ts`; event type strings only in `packages/schema` (use `EV.*`); SQLite only in `apps/daemon/src/store`;
child processes only in `apps/daemon/src/workspace`, adapters, `packages/adapter-kit` and `apps/cli/src/daemon-control.ts`.

## Rules

- Test first. Every bug fix adds a test named `regression/<issue>-<slug>.test.ts`.
- No real model calls in tests. Live tests are opt-in: `ION_LIVE=1` (opencode, free model), `ION_LIVE_GROK=1`, `ION_LIVE_CLAUDE=1` (only when the Claude adapter changed).
- UI and CLI copy: short, plain words, no jargon, no explanatory hints.
- Before committing: `pnpm check && pnpm build`.
- Keep `docs/README.md` (the index) and this file current when you add a package or a doc.

## Code health (CI enforces all of this)

| Check | Tool | Limit |
|---|---|---|
| File and function size | ESLint `max-lines`, `max-lines-per-function` | 1000 lines per file, 80 per function |
| Nesting and parameters | ESLint `max-depth`, `max-nested-callbacks`, `max-params` | depth 3, 3 callbacks, 4 params |
| Complexity and smells | `eslint-plugin-sonarjs`, ESLint `complexity` | cognitive 15, cyclomatic 15 |
| Dead code | knip, TypeScript `noUnused*`/`allowUnreachableCode: false`, ESLint dead-store rules | none allowed |
| Duplication | jscpd (`pnpm health:dup`) | ratcheted |
| Ratchet | `pnpm health` vs `health/baseline.json` | files >400 lines, functions >50 lines, cognitive >10, duplication %, `eslint-disable`, TODO may never grow |
| Golden files | Vitest `toMatchFileSnapshot` in `*/golden/` | contract, default config, CLI help change only on purpose (`vitest -u`) |
| Security | CodeQL, dependency review, `pnpm audit --audit-level high` | no high or critical |

Improved a metric? Run `pnpm health:update` and commit the new baseline.
