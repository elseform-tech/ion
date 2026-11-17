# ion docs index

| Doc | What it's for |
|---|---|
| [design/ion-design-lab.html](design/ion-design-lab.html) | The product spec: screens, design system, architecture, engineering, CLI (canvas v34). Open in a browser. |
| [architecture/contract.md](architecture/contract.md) | Event envelope and types, adapter interface, retries, import walls. |
| [research/acp-and-harnesses.md](research/acp-and-harnesses.md) | ACP protocol, how each coding agent is launched and signed in, quota policy for tests. |
| [../AGENTS.md](../AGENTS.md) | How to work in this repo: layout, walls, rules. |

## Plans

| Plan | Status |
|---|---|
| [01 Foundation](superpowers/plans/2026-11-17-01-foundation.md) | Done |
| [02 Adapters](superpowers/plans/2026-11-17-02-adapters.md): adapter kit, Claude Code, Grok Build and opencode (ACP), `ion ask` | Done |
| 03 Workspace, scheduler, policy, approvals, needs, retries | Not written |
| 04 Desktop app and Chats screens | Not written |
| 05 ion chief and Ions screens | Not written |
| 06 Routines, Activity, Artifacts, Tools | Not written |
| 07 Suggestions and memory | Not written |
| 08 More adapters (Cursor, Gemini CLI, Codex via ACP) | Not written |

## Packages

| Package | Docs |
|---|---|
| `@ion/schema` | `packages/schema/README.md` |
| `@ion/config` | `packages/config/README.md` |
| `@ion/client` | `packages/client/README.md` |
| `@ion/daemon` | `apps/daemon/README.md` |
| `@ion/cli` | `apps/cli/README.md` |
| `@ion/lint-rules` | `tools/lint-rules/README.md` |
| `@ion/adapter-kit` | `packages/adapter-kit/README.md` |
| `@ion/adapter-claude-code` | `packages/adapters/claude-code/README.md` |
| `@ion/adapter-acp` | `packages/adapters/acp/README.md` |
| `@ion/adapter-fake` | `packages/adapters/fake/README.md` |
| `@ion/health` | Code-health ratchet: see "Code health" in `AGENTS.md`; baseline in `health/baseline.json` |
