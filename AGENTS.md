# Working on ion

For humans and AI agents. Read `docs/architecture/contract.md` first.

## Layout

| Path | What |
|---|---|
| `packages/schema` | The contract: event envelope, event types, capabilities, wire protocol. Imports nothing. |
| `packages/config` | Config files and paths (`config.toml`, projects). |
| `packages/client` | Typed WebSocket client: Node entry for the CLI, `/browser` entry for the desktop app. |
| `packages/design-system` | Tokens (CSS variables from the spec), `Button`, `Spinner`, Lucide icons. |
| `packages/adapter-kit` | Harness contract, shared contract tests (`/contract`), event queue, delta batching, PATH/version helpers. |
| `packages/adapters/claude-code` | Claude Code via the Agent SDK; Claude login only. |
| `packages/adapters/acp` | Any ACP agent: Grok Build (`grok agent stdio`), opencode (`opencode acp`). |
| `packages/adapters/fake` | Scripted harness for tests (`ION_ALLOW_FAKE=1`). |
| `apps/daemon` | Owns all state. `src/store` is the only SQLite writer; `src/views` are tables updated per event; `src/runs` starts runs in each chat's worktree, applies the policy and retries; `src/access` decides Auto (rules, then a judge model); `src/gate` takes every tool call from each harness's own hook before it runs; `src/decisions` keeps your answers to agents' questions and what came of them; `src/needs` holds questions only you can answer; `src/ions` is ion chief and the project ions (messages, routing, questions in ion threads); `src/scheduler` queues runs; `src/workspace` owns git worktrees; `src/mcp` is ion's MCP server for runs (history, needs, memory, ask, decisions; a key per run); `src/adapters/registry.ts` is the only place adapters load. |
| `apps/cli` | The `ion` command. |
| `scripts/tour.sh` | The UX tour: a fresh ion with every chat state, for the tour every UI PR runs (see Rules). |
| `apps/desktop` | The desktop app: Tauri 2 shell (`src-tauri`: where the daemon is, and your initial) and a React UI that only displays the daemon's state (Chats screen). |
| `tools/lint-rules` | Custom ESLint rules that enforce the walls below (`ion/walls`, `ion/event-types-from-schema`, `ion/no-direct-db`, `ion/no-child-process`, `ion/no-model-names`). |

## Walls

| Package | May import | Never |
|---|---|---|
| `apps/desktop` | `client`, `schema`, `design-system` | `daemon`, adapters, `node:*` |
| `apps/cli` | `client`, `schema`, `config` | `daemon`, adapters |
| `apps/daemon` | `schema`, `config`, `policy`, `adapter-kit`, adapters via registry | `desktop`, `design-system` |
| `packages/adapters/*` | `schema`, `adapter-kit` | `daemon`, other adapters |
| `packages/policy` | `schema` | anything doing I/O |
| `packages/schema` | nothing | everything |

Also enforced: model names only in adapters (each harness lists its own; `ion/no-model-names`); the daemon imports adapters only in `apps/daemon/src/adapters/registry.ts`; event type strings only in `packages/schema` (use `EV.*`); SQLite only in `apps/daemon/src/store`;
child processes only in `apps/daemon/src/workspace`, adapters, `packages/adapter-kit` and `apps/cli/src/daemon-control.ts`.

## Rules

- Test first. Every bug fix adds a test named `regression/<issue>-<slug>.test.ts`.
- No real model calls in tests. Live tests are opt-in: `ION_LIVE=1` (opencode, free model), `ION_LIVE_GROK=1`, `ION_LIVE_CLAUDE=1` (only when the Claude adapter changed).
- UI and CLI copy: short, plain words, no jargon, no explanatory hints. Prefer an icon (with its name on hover)
  to a word, and fewer boxes.
- **Run a tour before every PR that changes what people see** (the desktop app, CLI output). `scripts/tour.sh`
  starts a fresh ion with a chat in every state (an edit, a question, a failure, a retry that works, one that gives
  up, a gated call, a running one, a plain chat in `default`) and prints the app's address. Then:
  - open every screen and state at 1440×900 and 900×700, and click what a person would: each chat, the work
    blocks and their steps, the brain popover, access, the question panel (open and collapsed), the side panel and
    its tabs, the sidebar's project menu, the drag handles;
  - send a real message from a new chat, and a follow-up, with opencode's free model, and watch it run;
  - run the CLI's main commands (`ion --help`, `status`, `projects`, `chats`, `needs`);
  - fix what reads oddly: extra or repeated words, hint text, a number that says nothing ("0s", "−0"), a box
    that holds nothing, a wait with no sign anything is happening, things that don't make sense to someone new;
  - list what you found and what you fixed in the PR. `scripts/tour.sh stop` when done.
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
