# Skills through the Agent SDK's `plugins`

Plan 18, Task 5. Can ion hand Claude Code the skills you turned on, without loading your own Claude settings
(`settingSources: []`, so ion's gate sees every tool call)? How T3 Code does it (read 2026-11-20,
github.com/pingdotgg/t3code): `plugins: [{ type: "local", path }]`.

## The probe (2026-11-21, one short live call)

- Agent SDK `@anthropic-ai/claude-agent-sdk` 0.3.326, the installed `claude` binary, the Claude login (no API key),
  the smallest model.
- A plugin folder in the shape Claude Code reads (`--plugin-dir`):

  ```
  plugin/
    .claude-plugin/plugin.json   { "name": "ion-skills", "version": "0.0.0", "description": "…" }
    skills/ion-probe/SKILL.md     front matter (name, description), then a line with an inline shell
                                  command (!`echo INJECTED-RAN`), then "run `echo ion-probe-ok` with Bash"
  ```
- Options: `settingSources: []`, `permissionMode: "default"`,
  `plugins: [{ type: "local", path, skipMcpDiscovery: true }]`, `settings: { disableSkillShellExecution: true }`,
  a `PreToolUse` hook standing in for ion's gate (logs and allows), and `canUseTool` (logs and allows).
- Prompt: "Run the ion probe. Then list the skills you have, one line each (names only)."

## What happened

- The init message listed the plugin (`ion-skills@inline`) and the skill as `ion-skills:ion-probe` (skills and slash
  commands).
- The model called `Skill {"skill":"ion-skills:ion-probe"}`, then `Bash {"command":"echo ion-probe-ok"}`. **Both
  reached the PreToolUse hook** (ion's gate) before they ran. `canUseTool` wasn't asked for either: Claude Code runs
  these without asking in the default mode, which is why ion gates through the hook, not `canUseTool`.
- Its reply listed `ion-probe` among its skills.
- The inline shell line reached the model as `Injected: [shell command execution disabled by policy]` (read from the
  session's transcript): with `disableSkillShellExecution`, a skill's `` !`command` `` never runs, so a skill can't
  run anything outside the gate.
- Your own skills in `~/.claude/skills` were **not** loaded (`settingSources: []` keeps them out); only the plugin's
  and Claude Code's built-in ones were.

## What ion does with it

- Skills work for Claude Code: on and off in Settings → Tools → Skills.
- Per run, ion writes a plugin folder of the skills you turned on to `<data>/skills/<runId>/` (never the worktree),
  passes it with `skipMcpDiscovery: true` (a skill can't add MCP servers) and
  `settings: { disableSkillShellExecution: true }`, and removes it when the run ends.
- Each copied `SKILL.md` keeps only its name and description in the front matter: `allowed-tools` (which would skip
  asking) and `hooks` (commands of its own) are dropped. Tool calls a skill leads to still reach the gate, as above.
- Other agents (Codex, opencode, Grok) read their own skill folders; ion passes them nothing, so their skills show as
  "Uses its own".

## Adding skills with ion's commands (Plan 18 Task 8)

- `ion skills add <name> --from <link or folder>` copies a skill into ion's own skills folder, `skills/` beside
  `config.toml` and `mcp.json` (out of every run's reach, like them). A folder is read as ion reads any skill (no
  links, no dotfiles, size-capped); a link must be a public https `SKILL.md` (a GitHub `…/blob/…` page is fetched as
  its raw file), at most 256 KB, with front matter that names it.
- It starts off and shows "New" on Settings → Tools → Skills with whose it is ("ion"). Claude Code gets it once you
  turn it on, as it gets Claude's own skills. Agents that read their own folders never see ion's folder, so nothing
  added this way is on anywhere until you turn it on.
- A chat's agent may add one only from a folder in its own worktree (or a public link). Where it came from and which
  chat added it is kept in ion's data (`added.json`), shown on the row.
