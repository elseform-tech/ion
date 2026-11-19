# @ion/adapter-codex

OpenAI's Codex CLI, driven through its app-server: `codex app-server`, JSON-RPC on stdio (Codex's own protocol;
Codex doesn't speak ACP). Protocol notes and why: `docs/research/acp-and-harnesses.md` ("Codex").

- **Sign in:** `auth.status()` runs `codex login status` (exit code 0 = signed in) and keeps only how (ChatGPT or an
  API key). A run checks `account/read` and reads the account's `type` only, never its email. Login: `codex login`.
- **Models:** `model/list`, hidden ones left out, kept 10 minutes. Effort goes with each turn (`max` is `xhigh`).
- **Every thread asks before tools:** `approvalPolicy: "untrusted"`, `approvalsReviewer: "user"` (not Codex's
  auto-reviewer), `sandbox: "workspace-write"` with network on. Commands, edits (by their files) and MCP tools
  (an elicitation Codex sends for them) go to the daemon's `decide()`; anything that goes wrong declines.
- **Gate:** with a run's gate, ion passes a `PreToolUse` hook with `-c` (`hook/ion-gate.mjs`, run with the daemon's
  Node) for every tool, and trusts exactly that hook by the hash Codex reports (`hooks/list`): learned on the first
  start, kept while the daemon runs. Nothing is written to your Codex folder. If Codex won't run the hook, ion
  won't run Codex. `gate.ts` reads the hook's payload (an `apply_patch` becomes its files; one with none readable
  names no file, so it asks). The commands Codex runs get `ION_GATE_URL` blanked
  (`shell_environment_policy.set`), so they can't read the gate's key; network stays on, as for ion's other agents.
- **Fail closed:** an edit approval for files ion never saw is declined; an MCP approval form is asked about only
  when exactly one call to that tool is running on that server, else declined.
- **Always off under ion:** Codex's question card (`features.default_mode_request_user_input=false`; a request is
  answered with an error pointing at ion's `ask` tool) and its background memory agent (`features.memories=false`).
- **ion's MCP server** goes in the thread's `config.mcp_servers` over stdin, bearer header included, never in argv.
- **Resume:** `thread/resume` (an unknown thread is `ResumeFailed`). ion's instructions are the thread's
  `developerInstructions`. ion's judge (`bare`) gets a throwaway, read-only thread whose tool requests are declined.
- One app-server per turn; `interrupt()` sends `turn/interrupt`, then stops the process after 3 s.

Tests: the shared contract suite and the adapter's own run against `test/fake-app-server.mjs`. Live (opt-in):
`ION_LIVE_CODEX=1` (uses your Codex plan; `ION_CODEX_MODEL` picks a model): a plain answer, and a command stopped
by ion's gate.
