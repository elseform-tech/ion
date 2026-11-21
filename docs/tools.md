# Tools: MCP servers, hooks and skills (Plan 18, PR A)

What ion gives every chat's agent besides its own tools, where each lives, and how ion keeps your keys out of agents'
hands. Settings → Tools shows all three (Connections, Hooks, Skills); `ion mcp|hooks|skills` do the same from a terminal.

## MCP servers (`mcp.json`)

- **The file.** `mcp.json` beside `config.toml` (`~/.config/ion/mcp.json`, or `$ION_HOME/mcp.json`), in the standard
  `{ "mcpServers": { … } }` shape: `command`/`args`/`env` for a local server, `type: "http"` + `url`/`headers` for a
  remote one. `${NAME}` (and `${NAME:-default}`) is filled at run start from the keychain, then the environment
  (never an `ION_*` name). Re-read on every call and run start; the app refetches on focus. Open config file opens it.
- **Consent.** A server new to the file starts **off** until you turn it on in the app; one whose command, args, env,
  URL or headers change goes back off. The "on" marks are HMAC-signed with a per-install key in the vault, so a write
  past the gate can't forge them. Hooks work the same way.
- **Keys and tokens.** Keys you type (Add key) are keychain items `key:<server>:<NAME>`; OAuth tokens live in an
  AES-256-GCM vault file per server in ion's data folder, keyed by `vault-key` in the keychain. A locked keychain turns
  servers off with one plain line.
- **OAuth.** Sign in follows the MCP spec (protected-resource metadata, PKCE required, a fixed loopback callback on
  47291–47299 open only while a sign-in is pending). Discovered URLs must be public (no loopback/private/link-local)
  unless the server itself is local; tokens are bound to the filled URL's origin.
- **The gateway.** Agents never get your servers' commands, URLs or keys: each run sees only ion's URLs
  (`/mcp/s/<name>`, the run's key). Remote calls go through ion's gated proxy (ion adds the key or token); local
  (stdio) servers are started by the daemon in their own process group for that run and stopped when it ends, in an
  empty folder ion owns (`<data>/mcp-run/<runId>`, 0700, removed at run end), never the chat's worktree, so nothing an
  agent writes there (`.npmrc`, `node_modules`, `x.py`, a relative script) runs with your keys. A server that needs the
  chat's folder names it in mcp.json: `"args": ["${ION_WORKTREE}"]` (also in `command`/`env`) is filled per run. Every
  `tools/call` is judged by its real name and input; batches are refused; only a short list of methods passes ungated.
- **Only ion's tools in ion's chats.** Each agent's own MCP servers and hooks are switched off in ion's chats where the
  agent allows it (see `research/acp-and-harnesses.md`, "Only ion's tools in ion's chats"). Plugins stay the agent's.
- **Import.** Tools reads your agents' own configs (Claude Code, Codex, opencode, Grok Build) only when you open it or
  run `ion mcp import --list`. One line names what it found ("4 servers in Claude Code, Codex and opencode"; one agent:
  "New in Codex: sentry" later). Import shows each server's command or host and the keys it needs first; they come in
  off, marked "Imported from <agent>". A server from a project's own file comes in only on its own. Dismiss hides the
  line until something new appears. `ION_AGENTS_HOME` points this reading (and skills) at another folder: the tour
  seeds a fake one so it never reads yours.

## Hooks

Every ion event can run a command of yours (A chat starts, finishes, fails, Something needs you, You answered, A
routine ran, A chat is archived, The briefing is posted), plus **Before a tool runs**, where exit 2 refuses the call
with your hook's words. A hook gets the event as JSON on stdin and `ION_EVENT`, `ION_PROJECT` and `ION_EVENT_CHAT`
(never `ION_CHAT`, so `ion` works in a hook), plus `ION_HOME` when set. Auto-approval is the built-in Before-a-tool
check. Each event hook may run 60 s; Before-a-tool hooks 10 s each and 15 s in all per tool call (the rest are
skipped); at most 4 hook processes at once per run. Each runs in its own process group; each row shows its last result
("Ran 7m ago").

## Skills

Your agents' own skills (Claude Code's `~/.claude/skills`, a project's, and the other agents' where they keep them),
on or off per skill. A Claude Code run gets a plugin folder of the ones on (only `name` and `description` copied; removed at
run end). A skill's files may be read and its scripts run, never written; in Auto each script run goes to the judge.

## ion's commands for agents

A chat's agent finds `ion` first on its PATH (`<data>/bin/ion`, the daemon's own CLI) with its run's key
(`ION_RUN_KEY`), which reaches only these commands: `ion mcp search <name>` (the official MCP Registry), `ion mcp add …
--from <registry id>`, `ion skills add`, `ion hooks add`, `verify`, `doctor`, `ls`, `remove`. What an agent adds comes in
**off**, with its source and the chat that added it on its row and a line in that chat ("github added, off · Tools").
`doctor` never starts a server that's off (one GET to a remote one's URL as written, nothing filled). Only you turn
things on, sign in or add keys.

## What ion refuses, and what it only guesses (the user, 2026-11-21)

- **Refused in every mode**, with a safer route in the message the agent reads: ion's own files and folders (config,
  `mcp.json`, the data folder, the vault, `~/.cache/ion`), your keychain secrets (`security`/`secret-tool` however
  called), environment dumps, dropping or overriding `ION_RUN_KEY`/`ION_CHAT` (`env -i` included).
- **A guess** (a script ion can't read or that may escape, one the command creates, decoded base64 that runs, a launcher
  that clears the environment before `ion`, a command it can't follow): in Auto the judge decides, shown the start of
  each project script that will run (64 KB each, 128 KB in all) and any decoded text; its no asks you ("ion is wary of
  this: …", Allow once / Always allow in this project / Don't allow, 4 minutes). In Full it asks you.
- Known limits of a text gate (run-time-built commands, interpreter string-building) are listed in the PR; Plan 18
  Task 12's OS sandbox is the real control.
