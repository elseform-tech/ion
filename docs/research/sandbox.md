# Agents in the OS sandbox, away from ion's own files

Plan 18, Task 12. The user, 2026-11-21: "agents run in the OS sandbox". The Task 8 review showed that a chat's agent,
running as you, could read ion's full access key in `daemon.json` and get round "only you turn it on". Rules over
command text (the run-key and script-scanning stopgaps, frozen after Task 9) kept finding new tricks: Python stripping
the environment, base64-decoded paths, a script written then run, `deno`/`bun`/`perl`/`tsx`, `local ION_RUN_KEY`,
`daemon.json` reached through `$XDG_*`/`$ION_HOME`. The OS sandbox is the control now; the word rules that only guarded
the key are relaxed in sandboxed runs (below).

## What a run's sandbox does

- **Denied (no read, no write):** ion's data folder (`$ION_HOME/data`, else `~/.local/share/ion`: `daemon.json`,
  `ion.db`, the vault, `added.json`, logs, other chats' worktrees), its config folder (`$ION_HOME`, else
  `~/.config/ion`: `config.toml`, `mcp.json`) and its cache folder (`~/.cache/ion`: opencode's carried config).
- **Let through:** the run's worktree (read and write), its skills plugin `<data>/skills/<runId>` (read), ion's `ion`
  launcher `<data>/bin` (read and run; it stays in the data folder, let through by path), and for opencode its own
  folder in ion's cache (read).
- **Not writable:** the agent's own config (Claude Code: `settings.json`, `settings.local.json`, `CLAUDE.md`, `agents`,
  `commands`, `skills`, `hooks`, `plugins` under `~/.claude`; Grok: `hooks` (ion's gate hook), `config.toml`, `skills`;
  opencode: `~/.config/opencode`, `~/.opencode`). Its sessions and state it still writes.
- **As it is:** the network (ion's MCP, gateway and gate are on 127.0.0.1), the agent's login (keychain, its auth
  files), the project, temp folders, caches.
- Every process the agent starts inherits the sandbox; nothing in the run can leave it.
- `ion` inside a chat reaches ion with `ION_PORT` and `ION_RUN_KEY` only; it never reads `daemon.json`
  (`apps/cli/src/connect.ts`, `reachRun`).
- Where the computer has no sandbox, the run still starts: Settings → Agents says "Not sandboxed" on each agent and the
  daemon's log says so once. The word rules then stay as they were.

Code: `packages/adapter-kit/src/sandbox.ts` (profile, bubblewrap arguments, detection), `apps/daemon/src/runs/
sandbox.ts` (a run's paths), each adapter's start. Goldens: `packages/adapter-kit/golden/seatbelt.sb`, `bwrap.txt`.

## macOS: Seatbelt (`sandbox-exec`)

A generated profile: `(allow default)`, then `(deny file-read* file-write* (subpath …))` for ion's folders, then the
exceptions; later rules win. Paths are given as written and as their real path (`/var` is `/private/var`). Checked
2026-11-21 on macOS 26 (Darwin 25.5), each in `sandbox.test.ts` against the real sandbox:

- `cat`, Python string concatenation, a script written then run, a base64-decoded path, a symlink: all
  "Operation not permitted". A different case (`ION/DAEMON.JSON`) too: Seatbelt checks the real file.
- A hard link to `daemon.json` can't be made (creating it needs the source).
- **Moving a folder above ion's** (`mv ~/.local/share ~/x`) would carry ion's files out from under the path rule, so
  the folders above ion's can't be renamed or removed (`(deny file-write* (literal …))`; creating files inside them is
  unaffected).
- The folders that hold the run's own paths (`<data>`, `<data>/worktrees`) can be looked at (`file-read-metadata`, so
  `realpath` and `getcwd` work) but not listed.
- git in a worktree inside the data folder works (its `.git` points into the project's own repo).

**Nesting:** macOS refuses a sandbox inside a sandbox: `sandbox-exec -p … sandbox-exec -p … true` fails with
`sandbox_apply: Operation not permitted` (exit 71), checked 2026-11-21. So ion never wraps an agent that sandboxes its
own commands, and when ion itself runs inside a sandbox, detection (`sandboxKind`) finds none and says "Not sandboxed".

## Linux: bubblewrap

`bwrap --die-with-parent --unshare-pid --bind / / --dev /dev --proc /proc`, an empty `--tmpfs` over each of ion's
folders, the exceptions bound back (`--ro-bind-try` / `--bind-try`), the agent's config `--ro-bind-try`.

- Not `--ro-bind / /` (as the brief first said): a read-only root stops agents writing their own sessions, caches
  and temp files, which stay as they are.
- `--unshare-pid` with a fresh `/proc`: otherwise `/proc/<ion's pid>/root/…` reaches the real folders.
- **Landlock** isn't used: it grants access by folder and can't take back a folder under one it allows (no "all of
  home except `~/.local/share/ion`"), and Node can't call it without a helper.
- Not tried on a Linux machine in this task (the goldens fix the arguments); detection runs `bwrap --bind / / true`
  first and says "Not sandboxed" where that fails (no user namespaces, no bwrap).

## Each agent

| Agent | Its own sandbox | What ion does | Covers |
|---|---|---|---|
| Claude Code (2.1.330, Agent SDK 0.3.326) | Optional (`sandbox.enabled`); covers Bash only, not its Read/Edit tools or MCP servers it starts; moves the network behind its own proxy (domain prompts) | ion's Seatbelt around the whole `claude` process, through the SDK's `spawnClaudeCodeProcess`. Its own stays off (`settingSources: []`, so your `sandbox.enabled` isn't read), so nothing nests | Read tool, commands, everything it starts |
| Codex (0.153.2) | On by default (Seatbelt / its Linux helper) for its commands; limits writes, reads almost everything | Its own, with a permission profile: `default_permissions="ion-run"`, `extends=":workspace"`, ion's folders `"none"`, the run's paths `"read"`/`"write"`, network on. The thread's `sandbox` setting is left out (with it the profile isn't active) | Its commands; its own process (apply_patch, MCP) is not sandboxed: ion's gate guards those |
| opencode (1.18.8) | None (permission prompts, i.e. ion's gate) | ion's wrapper around `opencode acp` | Everything |
| Grok Build (1.0.92) | None (permission prompts, i.e. ion's gate) | ion's wrapper around `grok agent stdio` | Everything |
| fake | Starts no process | Nothing: "Not sandboxed" (tests only) | — |

Codex, probed without a model (2026-11-21, `codex sandbox -c …` and the app-server's `command/exec`): with the profile,
`cat <ion folder>/daemon.json` → "Operation not permitted"; a write in the workspace works, one in `~` doesn't; a
narrower `"write"` entry inside a `"none"` folder wins; `curl https://example.com` → 200 with `network={enabled=true}`.
`thread/start` without `sandbox` reports `activePermissionProfile: { id: "ion-run", extends: ":workspace" }`; with
`sandbox: "workspace-write"` it reports none (the profile is replaced).

## Live (2026-11-21, a temporary ION_HOME)

- **opencode 1.18.8** first stopped at its start inside the sandbox: `FileSystem.writeFile (…/opencode/.gitignore)`:
  it writes that file into its config folder when it's missing. ion now writes it (byte for byte) when it prepares the
  folder, and lets a run write the folder only while opencode's plugin package isn't installed there yet (a first
  start). After that, opencode started and opened a session in the sandbox; its free model was out of quota, so the
  chat itself ran on Grok.
- **Grok Build 1.0.92** (Full access): created a file, `git add && git commit && git log`, `ion mcp ls` (through
  `ION_PORT` and the run key), the `tiny` local server's `echo` through ion: all worked. Then, asked to read ion's files:
  a base64-decoded path to `daemon.json` → `Operation not permitted` (the word rule no longer guesses; the OS stopped
  it); a Python script it wrote, given the folder base64-decoded → `PermissionError: [Errno 1] Operation not
  permitted`; `os.listdir` of `~/.cache/ion` built from pieces → `Operation not permitted`. Plain `cat daemon.json`,
  Python naming ion's folder and `ls ~/.cache/ion/opencode` were refused by ion's word rules first (defence in depth).
  ion's token appeared in no output and no event.
- **Claude Code** (one haiku run): started inside the sandbox through `spawnClaudeCodeProcess`, signed in with its
  usual login; a base64-decoded `cat daemon.json` → `Operation not permitted`.
- **A hook** on "A chat finishes": read the project's README, and `cat daemon.json` → `Operation not permitted`.
- The daemon's log had no errors.

## ion's local servers and your hooks

- Local MCP servers ion runs (`workspace/mcp-bridge.ts`) start in the sandbox: ion's folders denied (they get their
  values through their env), their own folder `<data>/mcp-run/<id>` and plugins' data `<data>/plugin-data` writable.
- Hooks (`workspace/hooks.ts`) are your commands, but they can run a project's code: the same denial; the project is
  readable. `ion` inside a hook can't read `daemon.json` either, so it says ion isn't running.

## The word rules once a run is sandboxed

Kept, in every mode (defence in depth, and what the sandbox doesn't reach): ion's own files named in a call, your
keychain items (`security`, `secret-tool`: the keychain isn't a file), an environment dump (the run's MCP key and
`ION_RUN_KEY` sit in the agent's environment), dropping or overriding the run's key or chat marker (`unset`,
`ION_RUN_KEY=…`, `env -i`, `env -u`).

Relaxed (no longer a guess that asks you or goes to the judge as one): a launcher that clears the environment before
`ion` (`sudo`, `exec -c`, `su`), decoded text that runs (`base64 -d | sh`), a script ion can't read or one that names
ion's files or drops the key, a command ion can't follow. Each only guarded the key in `daemon.json`, which no process
in the run can read now. They still go through Auto's rules and judge like any other call. On a computer without a
sandbox they stay as they were. The reasons for a script ion can't read are now one ("it runs a script ion can't
read"), so an answer says nothing about a file.

## What the sandbox doesn't do

- **opencode's carried config** (`~/.cache/ion/opencode/<hash>/opencode/opencode.json`): opencode must read it, and the
  sandbox can't tell opencode from the commands it runs, so they can read it too. It holds what your own opencode
  config holds (provider keys only if you wrote them there; opencode's login is in its own `auth.json`), which a run
  could read from your config folder anyway. Nothing in a run can write it.
- **The keychain:** `(allow default)` keeps the agent's own login working, so `security find-generic-password` still
  works from a script; ion's word rule refuses commands that name it, and ion's own key isn't in the keychain.
- **Other processes:** a same-user debugger attach or `ps eww` isn't blocked; ion's token is never in an environment.
- **Codex's own process** isn't in a sandbox of ion's (only its commands are): its file edits and MCP calls go through
  ion's gate and hard rules.
- **ion's own turns and the judge** aren't sandboxed (ions only read, through ion's gate).
