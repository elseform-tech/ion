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
- **Agents bring their own tools** (the user, 2026-11-21). In ion's chats each agent loads its own MCP servers, skills
  and plugins by default, beside ion's; Settings → Agents has **Use its own tools** per agent (`agents.<id>.ownTools`
  in config.toml, default on). Off is the old "only ion's tools" (Task 9). Hooks stay ion's: an agent's own hooks are
  off wherever it can turn them off; where it can't (Grok's `~/.grok/hooks`, opencode's plugins, which are hook code),
  Settings → Agents says **Its own hooks run too**. ion's gate judges every call, an agent's own tools' too, hard rules
  first. How each agent does it: `research/acp-and-harnesses.md`, "Agents bring their own tools".
  - Claude Code still loads no settings files (its permission rules and hooks stay out) and MCP stays strict. ion reads
    its servers (`~/.claude.json` and this project's entry there; `${VAR}` and `${VAR:-default}` filled as Claude fills
    them, but only from the environment an agent may have: ion's `ION_*`, run keys and your ion keys never fill one; a
    server whose variable isn't there is left out; SSE left out) and its enabled plugins
    (`~/.claude/plugins/installed_plugins.json` and `enabledPlugins`; their servers too, `${CLAUDE_PLUGIN_ROOT}` filled
    with its folder and `${CLAUDE_PLUGIN_DATA}` with a folder of its own in ion's data). **Its servers run through ion**
    (task review, 2026-11-21), as yours do: a local one is started by ion in the run's own folder with only its own
    values, a remote one is forwarded to, each gated with its real name, and Claude Code gets only ion's URL for each
    (nothing of a server in its environment). A plugin with hooks of its own, or with skills, subagents or
    commands, comes as ion's copy inside the run's skills plugin folder: no `hooks/`, no manifest `hooks`, and each
    markdown file's front matter parsed as YAML with any top-level `hooks` key dropped (a file it can't parse is left
    out, with one line in the daemon's log). ion walks those folders itself: a link must stay inside the plugin and
    anything deeper than three folders is left out. Its own skills in your
    home come on, as they are. A server's env and header values, and anything filled from `${VAR}`, are masked in the
    run's events; its command, args or URL only when they look like a key.
  - What a repo wrote isn't yours (security review, 2026-11-21): a project's `.mcp.json` servers and its
    `.claude/skills` show in Settings ("From shop's .mcp.json", "app's skills"), off until you turn each on (signed with
    ion's key; `tools.repoOn` / `tools.skills.on`). Claude Code's own approvals don't count. Only a repo's remote server
    gets a lasting switch. Every local one runs code here, whatever its command: Settings says "Asks in each chat", and
    the first time a chat would start it ion asks there (`shop's .mcp.json wants to run "local" from the repo`: Allow for
    this chat, or No; no answer in 4 minutes isn't kept, so ion asks again). Your answer, yes or no, is kept for that chat
    (in ion's data, across restarts). A repo's definition is never filled from your environment: one that asks for a
    `${NAME}` is left out with a line ("asks for NAME from your environment"), and so is one whose name isn't 1-40
    letters, digits, - or _ ("a server with an unusable name"). The row shows the whole URL as written, and the names of
    its headers or env. Codex and Grok load a trusted project's own config themselves ("Uses its own trust for project
    tools" in Settings → Agents); ion can't hold those.
  - Codex keeps its own servers and plugins (`features.plugins` stays on); its hooks are still turned off. Its own skills
    load whatever its switch says.
  - opencode: your `mcp`, `plugin`, `agent`, `command` and `instructions` (and your config folder's plugin files) are
    carried into ion's config file, ion's gate plugin last (it judges a call as your plugins left it); a folder of its
    own (`<hash>-own`), so a chat and ion's judge never rewrite each other's file. External skills are off
    (`OPENCODE_DISABLE_EXTERNAL_SKILLS`); with the switch on, ion names your home skill folders (opencode's, Claude
    Code's, `.agents`) in `skills.paths`; a project's never. Its `agent/` and `command/` folders (markdown) aren't
    carried. It runs with its log on stderr (warnings and errors): a turn with no progress for 2 minutes (updates that
    aren't progress don't count; paused while ion holds a call) fails with its logged reason ("opencode: Free usage limit
    reached…"), else "opencode didn't answer".
  - Grok keeps its own servers and skills and Claude's and Cursor's it reads; only the Claude and Cursor hooks are off.
  - Codex, opencode and Grok start their own servers themselves, with their own environment (Task 12's sandbox).
  - ion's own turns and the judge get ion's tools only.
  - Each agent says what its switch really turns off, by kind; Settings says "Off in ion" (dimmed) only for those, and
    "Also loads its own" for what it loads anyway (Codex's skills; Grok's servers, skills and plugins; opencode's
    `~/.opencode` plugins).
- **Settings → Tools** has Connections, Skills, Plugins and Hooks. Under the tabs (Hooks stay ion's) chips filter
  whose: All, ion, each agent. One row per thing several have (servers by name and what they run, skills by name and
  files, plugins by name and version), every face on it; the same name set up differently is a row each, **Differs**
  (what, on hover). An agent's own rows have no switch; one whose agent's own tools are off is dimmed, **Off in ion**.
  Plugins say what they bring ("4 skills, 1 server") and whether their hooks run. Reading is local: nothing is run or
  contacted.
- **Import** (optional, quiet). Tools reads your agents' own configs (Claude Code, Codex, opencode, Grok Build) only
  when you open it or run `ion mcp import --list`. The Import icon ("Use on every agent") shows each server's command or
  host and the keys it needs first; they come in off, marked "Imported from <agent>", and then reach every agent. A
  server from a project's own file comes in only on its own. `ION_AGENTS_HOME` points this reading (and skills,
  plugins) at another folder: the tour seeds a fake one so it never reads yours.

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
