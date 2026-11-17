# @ion/lint-rules

ESLint rules that keep the architecture in place (`eslint.config.js` turns them all on as errors).

| Rule | Protects |
|---|---|
| `ion/walls` | Which `@ion/*` package may import which (table in AGENTS.md); no relative imports into another package; no Node APIs in the desktop UI. |
| `ion/event-types-from-schema` | Event type names are written only in `packages/schema`; elsewhere use `EV.chatCreated` etc. |
| `ion/no-direct-db` | Only `apps/daemon/src/store` may use `better-sqlite3` / `drizzle-orm`. |
| `ion/no-child-process` | Only `apps/daemon/src/workspace`, adapters (and `adapter-kit`) and `apps/cli/src/daemon-control.ts` start processes. |

Tests: `pnpm --filter @ion/lint-rules test` (ESLint `RuleTester`, one valid and one invalid case per rule at least).
When you fix a bug class, add a rule or a regression test so it can't come back.
