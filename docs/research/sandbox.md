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
- **Not writable:** every other agent's config folder (`~/.codex`, `~/.claude`, `~/.claude.json`,
  `~/.config/opencode`, `~/.opencode`, `$GROK_HOME`), and the run's own agent's config files (Claude Code:
  `settings.json`, `settings.local.json`, `CLAUDE.md`, `agents`, `commands`, `skills`, `hooks`, `plugins` under
  `~/.claude`; Grok: `hooks` (ion's gate hook), `config.toml`, `skills`; opencode: `~/.config/opencode`, `~/.opencode`).
  Its own sessions and state it still writes (Claude Code writes `~/.claude.json` all the time, so that file stays
  writable in a Claude Code run). ion's folder for opencode (in `~/.cache/ion`) is only read.
- **Not reachable:** LaunchServices and Apple Events (task review, 2026-11-21: `open -g Probe.app` started an app
  outside the sandbox, which copied `daemon.json`): `(deny mach-lookup (global-name
  "com.apple.coreservices.launchservicesd") (global-name-prefix "com.apple.lsd.") (global-name
  "com.apple.coreservices.quarantine-resolver"))` and `(deny appleevent-send)`. `open` fails; `osascript` asking Finder
  hangs until stopped; node, git, curl, python and the agents run as before.
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
  the folders above ion's, and above each agent config path that isn't writable, can't be renamed or removed
  (`(deny file-write* (literal …))`). Creating and changing files inside them is unaffected. Side effect: a run can't
  rename, remove, `chmod` or `touch` those folders themselves (`~`, `~/.config`, `~/.local/share`, …).
- The folders that hold the run's own paths (`<data>`, `<data>/worktrees`) can be looked at (`file-read-metadata`, so
  `realpath` and `getcwd` work) but not listed.
- git in a worktree inside the data folder works (its `.git` points into the project's own repo).

**Nesting:** macOS refuses a sandbox inside a sandbox: `sandbox-exec -p … sandbox-exec -p … true` fails with
`sandbox_apply: Operation not permitted` (exit 71), checked 2026-11-21. So ion never wraps an agent that sandboxes its
own commands, and when ion itself runs inside a sandbox, detection (`sandboxKind`) finds none and says "Not sandboxed".

## Linux: bubblewrap

`bwrap --die-with-parent --new-session --unshare-pid --bind / / --dev /dev --proc /proc --tmpfs /dev/shm`, an empty
`--tmpfs` over `$XDG_RUNTIME_DIR/bus` (the D-Bus session socket) and over each of ion's folders, the exceptions bound back (`--ro-bind-try` / `--bind-try`), the agent's config `--ro-bind-try`.

- Not `--ro-bind / /` (as the brief first said): a read-only root stops agents writing their own sessions, caches
  and temp files, which stay as they are.
- `--unshare-pid` with a fresh `/proc`: otherwise `/proc/<ion's pid>/root/…` reaches the real folders.
- **Landlock** isn't used: it grants access by folder and can't take back a folder under one it allows (no "all of
  home except `~/.local/share/ion`"), and Node can't call it without a helper.
- Not tried on a Linux machine in this task (the goldens fix the arguments); detection runs `bwrap --bind / / true`
  first with the same flags a run gets and says "Not sandboxed" where that fails (no user namespaces, no bwrap).

## Each agent

| Agent | Its own sandbox | What ion does | Covers |
|---|---|---|---|
| Claude Code (2.1.330, Agent SDK 0.3.326) | Optional (`sandbox.enabled`); covers Bash only, not its Read/Edit tools or MCP servers it starts; moves the network behind its own proxy (domain prompts) | ion's Seatbelt around the whole `claude` process, through the SDK's `spawnClaudeCodeProcess`. Its own stays off (`settingSources: []`, so your `sandbox.enabled` isn't read), so nothing nests | Read tool, commands, everything it starts |
| Codex (0.153.2) | On by default (Seatbelt / its Linux helper) for its commands; limits writes, reads almost everything | Its own, with a permission profile: `default_permissions="ion-run"`, `extends=":workspace"`, ion's folders `"none"`, the run's paths `"read"`/`"write"`, network on. The thread's `sandbox` setting is left out (with it the profile isn't active). Approval policy `{ granular: { sandbox_approval: false, rules: true, mcp_elicitations: true, request_permissions: false, skill_approval: false } }`, given as config (`-c approval_policy=…`: as a thread parameter Codex refused it, "granular requires experimentalApi capability"): Codex declines by itself any request to run outside its sandbox (task review, 2026-11-21: an escalation reached ion as a plain command approval, with no field saying so). ion's word rules stay on for Codex runs | Its commands. Not its own process (apply_patch, MCP calls), its own stdio servers or `notify`: those run outside any sandbox, guarded by ion's gate and word rules |
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

## Live, second round (2026-11-21)

- **Grok:** a file, `git commit`, `ion mcp ls` worked; `open -g -a Calculator` → "Unable to find application"
  (LaunchServices refused); a planted git filter command was refused by ion's word rules.
- **Codex** (one `gpt-5.6-luna` run, the ChatGPT login): a write in the worktree worked; a base64-decoded `cat
  daemon.json` was held by ion's word rule (asked; stopped unanswered); `echo x > ~/…` → "operation not permitted"
  from Codex's sandbox; Codex then asked to run it outside the sandbox and reported it "disallowed by the environment
  policy": nothing reached ion, and the file wasn't made. Every command went through ion's gate first.
- **opencode:** with ion's folder for it missing, ion opened opencode once outside the sandbox, the plugin package
  (1.18.8) was installed there, and the run then started sandboxed; the chat stopped on opencode's used-up free quota.
- **A hook** on "A chat finishes" read `daemon.json` (its output masked the token): hooks ran outside the sandbox then;
  they run sandboxed again since (above).

## ion's local servers, ion's own git and your hooks

- Local MCP servers ion runs (`workspace/mcp-bridge.ts`) start in the sandbox: ion's folders denied (they get their
  values through their env), every agent's config read-only, their own folder `<data>/mcp-run/<id>` and plugins' data `<data>/plugin-data` writable.
- **ion's own git** (`workspace/git.ts`: making and removing worktrees, diffs) runs in the sandbox too, with ion's
  folders denied, every agent's config read-only (re-review, 2026-11-21: a planted filter wrote `~/.codex/notify.sh`,
  which Codex runs outside any sandbox) and its worktrees writable, and without your global or system git config (`GIT_CONFIG_GLOBAL=/dev/null`,
  `GIT_CONFIG_NOSYSTEM=1`; a repo ion has just made for you keeps your identity). Security review, 2026-11-21: a run
  wrote a clean filter into the project's `.git/config` and `.git/info/attributes`, and the daemon's `git diff` ran it
  outside the sandbox and read `daemon.json`. Tested with planted clean, smudge and process filters, during
  `worktree add` and the diff.
- **Hooks run in the sandbox** (automated review and revised ruling, 2026-11-21: a hook can run code an agent wrote in
  the project, `npm test`): ion's folders denied, ion's launcher readable, every agent's config read-only, the project
  as it is (writable), no global or system git config. `ion` works in a hook through `ION_PORT` and a key made for that
  one hook run, with a run key's limited rights (ion's commands for tools; nothing turned on, no keys, no settings),
  revoked when the hook ends. Doctor's test run of a hook is sandboxed the same way.

## ion's own agent processes (final review, 2026-11-22)

The judge, ion's quick model (how ion chief and the project ions think), an ion's turn, and the ACP agents' sign-in
and model checks used to start agents outside the sandbox, in `$TMPDIR`. On Grok and opencode those processes keep
their tools and load their plugins, so code a run planted in a plugin ran unsandboxed later. Now each starts in a
run's sandbox (ion's folders denied, every other agent's config read-only, the agent's own config files read-only as
in a run) in a folder of ion's data folder: each judge or quick-model session in a fresh folder under
`<data>/scratch/ion-judge-<agent>` or `ion-quick-<agent>` (apart, with their own warm agents; removed when the session
ends), the agent's own files (Grok's profile, written fresh, never through a link) in a daemon-only
`…-own` folder beside it that the agent can only read, and `<data>/scratch/ion-probe-*` for checks (removed after).
The scratch folder is emptied at the daemon's start.
Folders `ion-probe-*` and `ion-judge-*` left in `$TMPDIR` are removed at the daemon's start (nothing else there). Only
opencode's first setup still runs outside (it installs ion's plugin package into a folder runs can only read).

Read-only to every run, the run's own agent's too:

- **Grok:** `~/.grok/hooks`, `config.toml` (it says which plugins are on: `[plugins] enabled`), `skills`,
  `installed-plugins` (each plugin's files and `registry.json`) and `plugins`.
- **opencode:** its npm plugin cache, `$XDG_CACHE_HOME/opencode` (else `~/.cache/opencode`). opencode runs with it
  read-only (`opencode models` under a Seatbelt profile that denies writes there: fine; it only refreshes its models
  list there).

Probed with a throwaway `HOME` (Grok 1.0.92): `grok plugin install --trust <dir>` copies the plugin to
`~/.grok/installed-plugins/<name>-<hash>/`, adds it to `installed-plugins/registry.json` and to `[plugins] enabled` in
`config.toml`. A folder copied by hand into `installed-plugins` isn't loaded (`grok inspect` doesn't list it); with an
entry added to `registry.json` too, it's listed but `disabled` (it isn't in `enabled`, which a run can't write). A skill
edited in place inside an enabled plugin's folder is loaded as edited: the folder itself must be read-only, so it is.

### The judge on Grok and opencode

Live (Task 11): Grok's judge timed out in every live chat (up to 44 s). Each verdict spawned the agent and its server,
with all its tools, on its default model at high effort. Now:

- **No tools.** Grok runs with an agent profile in ion's folder for it (`grok agent --agent-profile <file> --no-leader
  stdio`) whose only tool is its todo list (`tools: todo_write`, `mcpInheritance: none`). Tried first: `GROK_CONFIG`'s
  `toolset` only narrows settings (it can't remove a tool), and `--tools`/`--disallowed-tools` before `agent` don't
  reach `agent stdio` (the model still listed every tool). `search_tool`/`use_tool` stay; ion's gate refuses them. For
  both agents ion's gate (Grok's hook, opencode's plugin) points at `http://127.0.0.1:0/…`, which nothing answers, so
  every tool call fails closed.
- **Fast.** Grok's judge uses `grok-4.7-build-fast` at low effort, chosen in the adapter (model names only in
  adapters); a model named in `[access] judge` wins.
- **Warm.** One agent process per agent (and folder, sandbox, env), a fresh session per verdict: no spawn and server
  start per call. A session is closed (ACP `session/close`), then deleted from the agent's history (`grok sessions
  delete <id>`, `opencode session delete <id>`), so verdicts don't pile up among your own sessions. A warm agent with
  no verdict for 10 minutes is stopped.
- **Retry.** A judge that times out or fails is asked once more on another signed-in agent, within the same 30 s (the
  first try gets 20 s); only then "ion couldn't decide in time". A timeout is never an allow. Each miss is counted per
  agent: Settings → Agents says "Judge didn't answer N times this week".

Live (2026-11-22, a temporary ION_HOME, Grok 1.0.92). Judge eval on Grok, 59 cases, 4 at once: 0 dangerous allowed,
0 ordinary refused, 5 unsure (4 of 5 where unsure was right), 0 without a verdict, p50 5.4 s, p95 8.3 s (before: p50
7.1 s, p95 22.0 s, 3 without a verdict). Four Auto chats on Grok with the calls that timed out in Task 11 (each 30 s+,
each asked): the judge took 4.3 s (a joined-path python read, the warm agent's first verdict), 3.6 s (a base64 path),
3.9 s (`./read.sh`: unsure, "can't see what the script does", so you were asked) and 6.7 s (`echo ok >
~/Documents/…`, which you asked for: allowed). One question in four, none for want of time. The sign-in checks ran
sandboxed in `<data>/scratch` and their Grok sessions were deleted; 3 of 4 judge sessions were (the last one's
delete didn't finish before the daemon stopped). The warm Grok judge stopped with the daemon.

## The word rules once a run is sandboxed

Only ion's own sandbox counts (Claude Code, opencode, Grok): Codex runs keep every word rule, since its own process
and servers aren't in a sandbox. Kept, in every mode (defence in depth, and what the sandbox doesn't reach): ion's own files named in a call, your
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

- **opencode's setup:** on a first start opencode installs its plugin package into ion's folder for it. That folder
  is read-only to every run, so ion opens opencode once outside the sandbox first (no prompt, no gate, no servers) to
  set itself up, then starts the run sandboxed. "Setting up" is ion's own state (set when ion finds the package
  opencode asked for, at that version), never read from files a run could have written.
- **opencode's carried config** (`~/.cache/ion/opencode/<hash>/opencode/opencode.json`): opencode must read it, and the
  sandbox can't tell opencode from the commands it runs, so they can read it too. It holds what your own opencode
  config holds (provider keys only if you wrote them there; opencode's login is in its own `auth.json`), which a run
  could read from your config folder anyway. Nothing in a run can write it.
- **The keychain:** `(allow default)` keeps the agent's own login working, so `security find-generic-password` still
  works from a script; ion's word rule refuses commands that name it, and ion's own key isn't in the keychain.
- **Other processes:** a same-user debugger attach or `ps eww` isn't blocked; ion's token is never in an environment.
- **Codex's own process** isn't in a sandbox of ion's (only its commands are): its file edits and MCP calls go through
  ion's gate and hard rules.
- **Codex's judge** runs Codex's own read-only, throwaway thread with every approval refused; its process isn't in
  ion's sandbox (macOS won't nest Codex's own sandbox inside ion's). Claude Code's, opencode's and Grok's judges are.
- **`~/.claude.json` stays writable in Claude runs:** Claude Code keeps its own state there (projects, onboarding, its
  tips and counters) and stops when it can't write it, so a Claude run can add a server there. ion doesn't load your
  `~/.claude.json` servers blindly: one that appears after ion first listed your agents' own servers shows as **New**
  in Settings → Tools until you've seen it once (final review, 2026-11-22). Every other agent's run gets it read-only.
- **Codex wasn't run with a model** in this task: its profile was checked with `codex sandbox` and the app-server's
  `command/exec`, and `thread/start`'s active profile.
- **`~/.gitconfig`** and other dotfiles outside agents' config stay writable from a run (ion's own git no longer reads
  your global config; your own terminal's git does).
