# What a beginner meets in ion today

Plan 21, Task 1 (2026-11-23). A brand-new ion, used the way someone who has never seen it would: open the app, try to
get a first finished answer. Three ways (opencode, Grok Build, no agent), in the app and in the CLI. This is the
"before" for Plan 21; Task 2 measures the same paths again.

Screenshots are in the main checkout's `.playwright-mcp/` (not committed), named `p21-t1-*.png`; each is cited by its
number below (`[03]` = `p21-t1-03-*.png`).

## How it was measured

- **A fresh ion each time:** its own `ION_HOME` in a scratch folder, with `[folders] projects` inside it (never
  `~/ion/projects`), built from `8fa8544`. The app ran from `apps/desktop` (Vite) in a browser at 1440×900, the CLI as
  `node apps/cli/dist/index.js`.
- **opencode:** the normal `PATH`, so every agent was found and signed in. `[ion] quick`/`deep` and `[access] judge`
  were set to `opencode` so that ion's own thinking wouldn't use Claude. opencode's free quota was out, so this is
  also the "quota out" path (Review Focus 2).
- **Grok Build:** a `PATH` holding only `node` and `grok`, so the other three agents show as Not installed. Quick, deep
  and judge were set to `grok-build`.
- **No agent:** a `PATH` holding only `node`, so all four agents show as Not installed. The config was left at ion's
  defaults apart from the projects folder. No real sign-in was touched: nothing was logged in or out, and Claude Code's
  sign-in was never touched.
- **Times** are wall-clock times from opening the app to the first finished answer. The run was driven by an agent, so
  typing and reading were near-instant: a person will take longer. Clicks and commands are the comparable numbers.
  Pressing Enter counts as a click, and typing a message doesn't count.

## Results

| Path | First finished answer | Time | Clicks | Commands |
|---|---|---|---|---|
| App, opencode (free quota out) | opencode fails 5 s after Send. The answer comes from Grok Build after "Continue on Grok Build", in `default`: "This project does not do anything yet." | 131 s (5 s to the failure, 62 s on Grok) | 4 | 1 (`ion daemon start`) |
| App, Grok Build, your own folder | Yes, about the folder: "a tiny tip calculator called tip-calc" | 102 s (33 s from Send) | 5 | 4 (`daemon start`, `projects add` fails on a non-git folder, `git init`, `projects add`) |
| App, no agent | **Never.** Send stays grey with no reason given, the agent picker shows four "Not installed" rows and no way to install, and ion chief answers "I couldn't reach my agent; try again." | none | 6, then a dead end | 1 |
| CLI, Grok Build | Yes, streamed: "Done · 17.0s · $0.0772" | 18 s for `ask` | none | 7 (`ion`, `status`, `daemon start`, `projects add` fails, `git init`, `projects add`, `ask -p`) |
| CLI, opencode (quota out) | **No way to read it.** `ask` exits 1 with a question; `ion answer <id> 1` says "Answered"; the chat then finishes on Grok, but no command prints its answer (`ion chats <id>` fails with "too many arguments"). | 9 s to the question | none | 4, then a dead end |
| CLI, no agent | **Never.** "No agent is signed in. See Settings → Agents." The agents aren't installed (not "not signed in"), and the CLI sends you to the app. | none | none | 4, then a dead end |

## Each path, screen by screen

### Opening ion (every path)

- **[01] "ion isn't running. Start it with: `ion daemon start`".** The app's first screen is a terminal command.
  - A newcomer may not know what a daemon is.
  - `ion` isn't on `PATH` after a build. The README's quick start uses `node apps/cli/dist/index.js`.
  - The app doesn't offer to start ion itself.
- **[02/10] The new-chat screen:** "What are we working on?", a message box, and a footer of `default`, the agent, a
  shield (access) and a ghost (Don't remember).
  - For 1–4 s the agent button says **"Agents"** while ion checks them, with no sign it's checking ([10]).
  - The project is `default`, which is an empty git repo ion made. A newcomer doesn't know it isn't their code.
  - The shield and the ghost have no words (a name on hover). That's fine by the copy rules, but nothing says what
    "Project's access" means for `default`.

### opencode (free quota out)

1. **Type, Enter [11].** The sidebar is still empty and the empty-state heading "What are we working on?" stays under
   the new message. "Thinking" shows with no agent name and no elapsed time.
2. **~5 s later [13]:**
   - The chat shows "opencode's free usage is used up — try again later or pick another model".
   - A question appears: "opencode hit its limit. Continue on Grok Build, or wait?", with Continue on Grok Build (starred),
     "Wait: ion goes on at 21:16", Always continue on Grok Build here, and Something else….
   - This is good: no bare error, and a next step.
   - But the sidebar's chat title is replaced by the question ("opencode hit its limit. Co…"), and the rail shows a dot.
   - The error says "pick another model", yet the picker lists ~40 opencode models (`ion harnesses`) and doesn't say
     which ones are free.
3. **Continue on Grok Build [14–16].**
   - "Continued on Grok Build — opencode hit its limit", then 61 s of work.
   - The first visible line is the handoff talking to itself: "The last run stopped at the usage limit, so I'll pick up
     from the worktree and check git status…".
   - Then a long red-grey line: "Denied by ion: echo "=== .git ===" && cat .git && … — Touches ion's own files". The
     agent wandered outside `default` looking for a project.
   - **The answer: "This project does not do anything yet. It is an empty Git repository…"** The beginner's first answer
     is about ion's placeholder folder, not their code.
4. **What the events show and the screen doesn't:**
   - **The judge fell back to Claude Code.** `[access] judge = "opencode"`, but opencode was out of quota, so ion's judge
     asked "another ready agent". That was Claude Code, at its default model (`claude-opus-5-5`, ~$0.01 each). That made
     3 Claude calls in a chat that never chose Claude, with Claude switched off for ion in the config.
   - Those judge runs land in the chat's own events as `run.finished {harness: claude-code}` and `usage.reported`. The
     screen shows nothing.
   - For a beginner without Claude this is harmless (the fallback is whatever is ready). For someone saving Claude quota,
     it is a silent spend.

### Grok Build, with their own folder

1. **Find where to add a folder.**
   - The project picker in the composer lists only `default`.
   - The sidebar's project menu [20] shows "All projects", **"No project matches"** (the search box is empty), and **New
     project**.
   - New project [21] asks only for a name. It makes a new empty folder; it doesn't pick an existing one.
   - The Ions screen has "Add project", which does the same thing under a different name.
   - **The app has no way to open an existing folder.** That needs the CLI: `ion projects add <path>`.
2. **`ion projects add ~/tip-calc`** prints "Not a git repository: …" and exits 1, with no hint. `git init` alone is
   enough (no commit needed), so this one-line fix could be done for the user or named in the message.
3. **Back in the app**, the new project doesn't show until a reload (projects live in config, not events). After the
   reload, the new chat still defaults to `default` [22], even though the user has a real project.
4. **Pick the project, type, Enter [23–24].**
   - Answer in 33 s, correct and about their code.
   - "Worked for 31s" opens to the steps [25]. Some steps show the agent's raw tool names: `run_terminal_command`,
     "Find tool ion memory_search memory_read decisions", and "Memory".
5. **Memory [27]:** "No memory" after the first chat. Nothing tells the beginner that ion remembers.
   - The Memory page shows **Dream** (Off / Nightly / Weekly) with no words about what it does.

### No agent

1. **[02] The new-chat screen** looks ready: the agent button says "No agent".
2. **Type [03]:** the Send button stays grey. No line says why or what to do.
3. **Agent button [04]:**
   - The header is **"Harness"**, over four greyed rows: opencode, Grok Build, Codex, Claude Code, each "Not installed".
   - No install command, no link, no Check again.
   - Model and Effort columns stay open and clickable, about nothing.
4. **Settings → Agents [05]:**
   - The same four "Not installed" rows. Each has a **switch that is on**, which reads as "this agent is on". It means
     "use its own tools".
   - Badges: "Its own hooks run too" and "Uses its own trust for project tools".
   - "When an agent hits its limit", "Pick by usage", and "ion's model: Quick" with an empty agent choice and a
     "Default" model.
   - None of it says how to get an agent.
5. **Settings → General [06]:** one row, "Chats ion runs at once · Auto".
6. **Ions → ion [07–08]:** "Message ion" works and sends. The reply is **"I couldn't reach my agent; try again."**
   Trying again can't help, and the reply doesn't say there is no agent.

### CLI

- **`ion` (bare):**
  - Prints the full help: 18 commands, including `daemon`, `harnesses`, `mcp`, `skills`, `hooks`, `routines`,
    `suggestions` and `decisions`.
  - Exits 1. Nothing says where to start.
- **`ion --help`:** the same.
- **`ion status`:**
  - Before the daemon runs: "ion isn't running. Start it with: ion daemon start" (exit 2).
  - After: "ion is running · 0 projects". With agents it adds usage lines such as "Grok Build · Learned from errors" and
    "Codex · Learned from errors", which read as a puzzle.
- **`ion ask "…"`:**
  - Without the daemon: the same "isn't running".
  - With no agent: "No agent is signed in. See Settings → Agents." The agents aren't installed, and the CLI sends the
    user to the app.
- **`ion ask` (Grok, `-p` project):**
  - Streams the reply and ends "Done · 17.0s · $0.0772". Good.
  - One step printed as **"· Used ."**, with an empty name.
  - Another printed as "Used ion memory_search decisions".
- **`ion ask` without `-p`** goes to `default`, and the help doesn't say so (`-p, --project <id>  Project`).
- **`ion projects add`:**
  - Its help says "Add a git repo".
  - A non-git folder fails with no fix.
- **`ion harnesses`:**
  - One line per agent, with opencode's ~40 model ids on a single line.
  - The command is `harnesses`, while the app's Settings say "Agents".
- **After `ion answer`:** no command shows a chat's messages. `ion chats` lists ids and states only.

## Defaults a beginner gets

| Setting | Default | What it means without Claude Code |
|---|---|---|
| `[ion] quick` / `deep` (ion chief, project ions, titles) | `claude-code` | When Claude isn't ready, ion chief uses the next ready agent (`brain.ts` `chiefBrain`/`nextBrain`). With no agent at all, ion chief says "I couldn't reach my agent; try again." [08] |
| `[access] judge` (Auto's decisions) | `claude-code:haiku` | When the judge's agent fails or is slow, the judge asks another ready agent once, at **that agent's default model** (Claude Code's is Opus), within the same time. Seen live: an opencode judge out of quota fell back to Claude Opus three times. Settings has no place to see or change the judge. |
| New chat's project | `default`: an empty git repo in the projects folder | The first answer is about an empty folder [16], and an agent looking for "the project" walks outside it and is denied [15]. |
| Agent order | opencode, Grok Build, Codex, Claude Code; the first ready one is picked | A beginner with opencode installed lands on its free model. When that quota is out, the first message fails (ion offers the next agent) [13]. |
| Access | Auto (the judge decides), "Project's access" | Fine. "Project's access" names a setting the beginner never set. |
| Memory | On; Dream Off | Nothing is remembered from a "what does this do" question [27]. |
| `[folders] projects` | `~/ion/projects` | `default` and every New project go there. A beginner's own folder must be added from the CLI. |
| Briefing | On at 08:30 | A notification built from ion's own state, with no model call (`notify/briefing.ts`). Harmless. |

## The concept words

Rule (the user, 2026-11-23): jargon is fine when it's the accurate word for the place (worktree, branch, diff, commit,
MCP in a developer-tools context). A word is flagged only when it's ion's own invented term that a newcomer can't
guess, when two words name one thing, when a plain word would be just as precise, or when the word is wrong for the
place.

| Word | Where it shows | What it means | Verdict |
|---|---|---|---|
| chat | App (sidebar, New chat), CLI (`chats`, `--chat`), docs | One conversation with a coding agent in a project, with its own worktree | **Keep.** The word a beginner expects. |
| thread | App (Ions: "A thread", "Start thread" step), docs | A chat an ion started for you | **Rename → chat** (two words for one thing). Where it matters, say "chat ion started". |
| run | CLI ("runs queue"), docs, events; app rarely ("Chats ion runs at once") | One agent turn inside a chat | **Keep** in docs and code. In the UI say "chat" or "turn" (the user already asked for "chats" not "runs"). |
| ion | App (rail "Ions", "Message ion", the name of ion chief's row) | The product, and also the assistant over all projects | **Keep** for the product. The chief row needs to tell itself apart from the project ions; see the next row. |
| ion chief | App (memory sources: "ion chief"), docs, CLI `ions` | The ion over all projects | **Clarify on hover.** The Ions screen calls it just "ion" [07] and Memory calls it "ion chief": pick one. |
| project ion | Docs, CLI (`ions`: "your projects' ions") | An assistant per project that starts chats and answers agents' questions | **Clarify on hover.** An invented term. Show it as "<project>'s ion". |
| harness | Agent picker header "Harness" [04], aria-label "Harness, model and effort", CLI `ion harnesses`, `--harness`, docs | A coding agent (opencode, Grok Build, Codex, Claude Code) | **Rename → agent** (Settings already says "Coding agents"). Keep `--harness` and `harnesses` as aliases for one release. |
| agent | App (Settings → Agents, "No agent"), CLI, docs | A coding agent | **Keep.** |
| routine | App (Activity: "No routines scheduled"), CLI `routines`, docs | A message an ion sends on a schedule | **Keep.** A plain word, explained by its row. |
| need | CLI `ion needs`, "Needs you" (sidebar group, notifications), docs | A question only you can answer | **Keep "Needs you"**. In the CLI, `needs` is the odd one: prefer `questions`, with `needs` as an alias. |
| decision | CLI `decisions`, chat step "Decisions", docs | Your past answers to agents' questions, and what came of them | **Clarify on hover.** A plain word, but its meaning (remembered answers) isn't guessable. |
| suggestion | Ions screen cards, CLI `suggestions` | Something ion chief proposes (a routine, an "always") | **Keep.** |
| Dream | Settings → Memory "Dream Off/Nightly/Weekly" [27], memory source "ion (dream)" | ion tidying its memory overnight | **Rename or clarify.** An invented term with no hint. "Tidy memory: Off / Nightly / Weekly". |
| access / Auto / Full access | Composer shield, "Project's access" | Whether ion checks each tool call (Auto) or lets everything run | **Keep**, but "Project's access" for `default` is odd. Clarify on hover: "Auto: ion checks risky steps". |
| gate | Docs, events (`by: "gate"`); not in the UI | ion's hook that sees every tool call before it runs | **Keep** (docs only). |
| judge | Docs, Settings → Agents "Judge didn't answer N times"; config only | The model behind Auto's decisions | **Clarify on hover** where it shows. Also show which agent judges (it can't be seen or changed today). |
| worktree | Chat events, agents' own words ("pick up from the worktree" [15]), README, docs | The git worktree each chat works in | **Keep.** Accurate here. |
| branch (`ion/what-does-…`) | Agent answers [16], `ion chats archive` ("its branch stays") | The chat's git branch | **Keep.** |
| Learned from errors | Settings → Agents usage line, `ion status` | ion has no usage gauge for this agent and only knows its limits from past errors | **Rename.** Wrong for the place: it reads as a boast or a bug. Say nothing, or "No usage info". |
| Its own hooks run too / Uses its own trust for project tools | Settings → Agents badges [05] | The agent's own hooks and project MCP trust apply alongside ion's | **Clarify on hover.** Accurate for experts, noise on a first visit. |
| "use its own tools" switch | Settings → Agents, one per agent [05] | Whether the agent also loads its own MCP servers, skills and hooks | **Clarify.** It looks like "agent on/off". Label it, or move it under the agent's row. |
| Quick / deep, effort | Settings → Agents "ion's model: Quick", Effort; composer brain popover | The model ion thinks with; how hard it thinks | **Keep** "Effort". **Clarify** "Quick" ("ion's model"). |
| default (project) | Composer project, sidebar group | A placeholder empty repo for chats with no project | **Rename** to something that says what it is ("No project" or "Scratch"). Today it reads as "your project". |
| Activity | Ions screen | Routines and threads running and due | **Keep.** |
| MCP, skills, hooks | Settings → Tools, CLI `mcp`/`skills`/`hooks` | Tools for every agent | **Keep.** Accurate in a developer tool, and out of the first-run path. |
| Starred | Sidebar project star | Keeps a project open in the sidebar | **Keep.** |
| Memory / Remember / Don't remember | Settings → Memory, the ghost in a new chat | What ion keeps between chats | **Keep.** |

## Which screens and commands get used (local counts)

There's no screen telemetry, so "which screens get used" is read from the user's own events.

**Where the data came from.** ion's path logic (`packages/config/src/paths.ts`) points to `~/.config/ion` and
`~/.local/share/ion`. Neither holds a database (only an `opencode` folder). The running main-checkout daemon uses
`ION_HOME=/tmp/ion-real`, so that is the user's real ion. It was read with `sqlite3 -readonly`, counts only, and no
content was copied out. The other ion homes on this machine are test and tour homes.

That ion holds 277 events, all on 2026-11-19 within about an hour. It's a short trial, not months of use, so these
counts can't rank features.

| What | Count |
|---|---|
| Chats | 7, in 3 projects (6 in a real project, 1 in `default`) |
| Runs | 7 (Grok Build 6, opencode 1); all finished `done` |
| Messages to ions (`ion.heard`) / ion replies (`ion.said`) | 4 / 11 |
| Ions with a thread (`view_ions`) | 2 |
| Agents' questions raised / resolved | 2 / 2 |
| Approvals requested / resolved (old approval events) | 9 / 20 |
| Memory written / forgotten | 1 / 1 |
| Suggestions, decisions, routine runs | 0, 0, 0 |
| Tool calls | 26 |

What this says for pruning:
- Chats and ion threads were used.
- Routines, suggestions, decisions and Dream were never used, and memory was used once.
- These are the first candidates to hide until needed (Plan 21's Global Constraints: hide, don't delete).

## Findings, worst first

1. **No agent means a dead end everywhere** [02][03][04][08].
   - In the app, Send stays grey with no reason given. The agent picker lists four "Not installed" rows and doesn't say
     how to install any of them.
   - ion chief says "I couldn't reach my agent; try again."
   - The CLI says "No agent is signed in. See Settings → Agents."
   - *Fix:* when no agent is ready, replace the message box with one row per agent ("Install: <command>" or "Sign in:
     <command>") and a Check again button. The CLI prints the same lines.
2. **The app can't open your own folder** [20][21][22].
   - "New project" only names a new empty folder, and "Add project" on the Ions screen does the same thing under another
     name.
   - The new chat defaults to `default`, an empty repo, so the first answer is "This project does not do anything yet"
     [16].
   - *Fix:* a "Pick a folder" step (the native folder picker) on first run and in the project menu, and new chats default
     to the most recent real project.
3. **A non-git folder is refused with no fix.** `ion projects add` prints "Not a git repository" and exits 1 (CLI), when
   `git init` alone is enough.
   - *Fix:* set up git for the user and say so in one line ("Set up git here").
4. **The judge falls back to Claude Code at Opus, silently** (events of the opencode chat; screenshot [16]).
   - With `judge = "opencode"` and opencode's quota out, the judge's retry went to Claude Code's default model 3 times.
   - Those judge runs' `run.finished` and `usage.reported` events land in the user's chat.
   - The default judge and ion's quick/deep are all `claude-code`, and Settings neither shows nor sets the judge.
   - *Fix:* the fallback uses the cheapest model of the next ready agent and skips agents the user keeps off for ion;
     show "Judge: <agent>" in Settings → Agents; keep judge events out of the chat.
5. **The app starts with a terminal command** [01]. "ion isn't running. Start it with: `ion daemon start`", and `ion`
   isn't on `PATH` after a build.
   - *Fix:* the desktop app starts the daemon itself, with a plain "Starting ion…" while it waits.
6. **In the CLI, an answer after a question can't be read** (CLI transcript).
   - After `ion answer`, the chat finishes, but no command prints its messages (`ion chats <id>` fails with "too many
     arguments").
   - *Fix:* `ion chats <id>` (or `ion answer` itself) streams or prints the chat's reply.
7. **opencode out of quota is handled, but reads oddly** [13].
   - The sidebar title becomes the question ("opencode hit its limit. Co…").
   - The error says "pick another model" without saying which ones are free.
   - The handoff's first line talks about "the worktree" and the "last run" to a person who sent one message [15].
   - *Fix:* keep the chat title, name a free model or the next agent in the error line, and hide the handoff's
     self-talk.
8. **Bare `ion` dumps 18 commands and exits 1** (CLI).
   - *Fix:* bare `ion` prints the three first steps (agents ready?, add a folder, ask), or "ion is running · N
     projects · ask with: ion ask "…" -p <project>".
9. **Settings → Agents reads as expert-only** [05].
   - The per-agent switch looks like "agent on" and means "use its own tools".
   - The badges "Its own hooks run too" and "Uses its own trust for project tools" sit on every row.
   - "ion's model: Quick" shows an empty agent choice when none is ready.
   - *Fix:* a label on the switch ("Own tools") or move it into a detail row; badges on hover; hide ion's model until an
     agent is ready.
10. **Waits with no sign of progress** [10][11][12].
    - The agent button says "Agents" for 1–4 s while the agents are checked.
    - After Send, the empty heading stays under the message, and "Thinking" has no agent or elapsed time for the first
      seconds.
    - The judge's 5 s per Auto decision shows nothing [23].
    - *Fix:* a shimmer on the agent button while checking; drop the empty heading once sent; "Thinking · Grok Build ·
      3s" from the start.
11. **Two words for one thing.**
    - "Harness" (picker header, `ion harnesses`, `--harness`) vs "Agents" in Settings [04].
    - "thread" vs "chat" on the Ions screen.
    - "ion" vs "ion chief" [07].
    - "Add project" vs "New project" [20].
    - *Fix:* use agent, chat, "ion chief" and "Add project" everywhere, with the old CLI words as aliases for one
      release.
12. **Invented or wrong words.**
    - "Learned from errors" (`ion status`, Settings).
    - "Dream" with no hint [27].
    - "No project matches" when nothing was searched [20].
    - "Project's access" on `default`.
    - *Fix:* drop "Learned from errors" (or "No usage info"); "Tidy memory nightly"; "No projects yet" with Add project;
      plain "Auto" on `default`.
13. **Projects added from the CLI don't appear in the open app** until a reload [22].
    - *Fix:* the daemon emits a projects-changed event, or the app re-reads projects on focus.
14. **Raw tool names in steps and the CLI** [25].
    - `run_terminal_command`, "Find tool ion memory_search memory_read decisions", and an empty "· Used ." line in
      `ion ask`.
    - *Fix:* map common agent tool names to plain verbs (Ran, Searched), and never print an empty step.
15. **Nothing shows that ion remembers** [27]. "No memory" after the first chat, and no line says what memory is for.
    - *Fix:* after the first answer, one quiet line naming what ion kept (or that it keeps notes as you work), linking to
      Settings → Memory.
16. **The README promises agents the app doesn't have.**
    - It lists Gemini CLI, Cursor CLI and Pi, but only opencode, Grok Build, Codex and Claude Code exist.
    - There is no user-facing getting-started section (only the developer quick start).
    - *Fix:* list the four agents, and add a 5-line "Start" section (install an agent, open ion, pick a folder, ask).
