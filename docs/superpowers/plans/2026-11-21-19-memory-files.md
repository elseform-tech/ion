# Plan 19: Memory as Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ion's memory becomes a folder of small Markdown files, one topic each, kept for you or for a project. To-dos are memory files too. Chats and ions find what they need through a quick index and read the details on demand. You can read and fix every file yourself.

**Architecture:** The files are the truth. SQLite holds a rebuildable index of them (FTS5 over name, description and text, plus scope, type and who may see it) and a history of every change: who made it, when, and the text before. The daemon is the only writer for chats and ions, through ion's MCP tools. It watches the folder, so your own edits are indexed and logged as yours. Agents never touch the files directly: Plan 18's sandbox keeps them out of ion's data folder, and the tools enforce scope and visibility the same way on every agent.

**Tech Stack:** TypeScript, Markdown with a YAML header (a small strict parser, no code execution), SQLite FTS5 in `apps/daemon/src/store`, `fs.watch` with debounce in the daemon, ion's MCP server, React.

**Spec:** the user, 2026-11-21:
- "can we repurpose memory into multiple memory files that ions or plain chat can read, of course, project scope, instead of one file covering everything";
- on storage: "use it as hybrid, sqlite for indexes and history (quick search) and memory for details i guess (slow)";
- on to-dos: "does memory cover todo as well".

Earlier, 2026-11-18: ion should remember "open tasks, ongoing tasks, their preferences, and even personal information they choose to share", and personal details stay local.

## Global Constraints

- **Where:**
  - `<data>/memory/you/<slug>.md` and `<data>/memory/projects/<projectId>/<slug>.md`.
  - A slug is 1–60 characters: lowercase letters, digits and `-`, unique within its folder.
  - **Open memory folder** in Settings opens it, via the opener scoped to that folder, like Open config file.
- **A file:** a YAML header, then the text (Markdown).
  - `name` (required, ≤ 80 characters).
  - `description` (required, one line, ≤ 160 characters: what the index shows).
  - `type`: `preference` | `fact` | `person` | `todo` | `reference`.
  - `see`: `chats` | `ions`.
  - For a to-do: `status` (`open` | `done`) and an optional `due` (ISO date).
  - Text ≤ 8 KB. At most 500 files per folder.
  - Unknown header keys are kept but ignored.
- **Who sees what:**
  - A project's chats see that project's files, plus your files marked `see: chats`.
  - A project's ion sees its project's files, plus all of yours.
  - ion chief sees everything.
  - The judge sees only the decisions it sees today; memory never reaches it.
- **Defaults for `see`:**
  - Project files: `chats`.
  - Your `preference` and `reference`: `chats`.
  - Your `person` and `fact`: `ions`. Personal details stay with ions unless you change it.
- **Who writes what:**
  - Chats write their own project's files, and your `preference` files only.
  - Ions write in their scope; only ion chief writes your `person` files.
  - You write anything, in the app or in an editor.
  - Writes are limited per turn (5 files) and per run (20).
- **The files are the truth; the database is derived:**
  - Deleting the index rebuilds it from the files at start.
  - History survives a rebuild: it's ion's events, the same as today's memory events.
  - A file that fails to parse keeps its last good indexed version, and Settings shows one plain line ("storefront/deploy.md can't be read").
- **Untrusted text:** everything read from memory reaches a model wrapped as data (`wrapData`), with control characters stripped. Nothing in a file is ever executed. Header parsing allows plain scalars only (no anchors, tags or custom types).
- **Private:** memory never leaves the machine except inside the prompts of the agents you use, exactly as today. Nothing is sent anywhere else.
- Copy rules (plain words, icons named on hover, no hint text), lab parity, code health, `pnpm check && pnpm build`, tour and live check before the PR (opencode free model and Grok; Claude only if needed), no real model calls in tests.

## Review Focus

1. You edit a file by hand while a chat writes to it. Neither change is lost silently: ion writes only if the file is unchanged since it read it (hash check), else it refuses with "Changed since you read it", and the chat reads again.
2. A file with a broken header, a huge file, a file that's a symlink out of the folder, a file named `../x.md`: each is skipped or refused plainly; nothing outside the folder is read or written.
3. A plain chat in project A asking for project B's memory, or for your `see: ions` files: it gets nothing, not even names.
4. Text in a memory file that says "ignore your instructions…": it stays data, and the agent's rules don't change.
5. Old memory notes after upgrading: every one becomes a file, in the right folder, with a header, and none are lost or duplicated if the daemon restarts mid-move.

---

### Task 1: Memory files, with the index and history in SQLite

**Files:**
- Create `apps/daemon/src/memory/files.ts` (read, parse, write, slug).
- Create `apps/daemon/src/memory/watch.ts` (folder watch with debounce; your edits → events).
- Rewrite `apps/daemon/src/views/memory.ts`: `view_memory` (path, scope, slug, name, description, type, see, status, due, hash, updated_at, by) plus a `view_memory_fts` FTS5 table (name, description, text).
- Modify `apps/daemon/src/memory/index.ts`, `packages/schema` (events below; contract golden on purpose).
- Create `apps/daemon/src/memory/migrate.ts`.
- Tests next to each.

**Interfaces:**
- **Events:**
  - `memory.written { path, scope, slug, header, hash, by: "you" | { chatId, runId } | { ion: id }, before?: { hash, text } }`;
  - `memory.forgotten { path, by, before }`.
  
  `before` holds the previous text, capped at 8 KB, for undo.
- **Functions:**
  - `memoryFiles.read(path)` and `.write({ scope, slug?, header, text, expectHash?, by })`;
  - `memoryView.search(db, { scopes, see, q?, type?, status? }) → MemoryRow[]`;
  - `memoryView.history(db, path)`.
- **Migration:** each existing note becomes a file. Your notes → `you/<slug>.md` (type `fact`, see `ions`). A project's → `projects/<id>/<slug>.md` (type `fact`, see `chats`). The name is the note's first 60 characters, and the description its first line. It's idempotent: a migrated note carries its old memoryId in the header (`from: m…`) and isn't moved twice.

- [ ] Tests:
  - "a file is parsed into its header and text";
  - "a broken header keeps the last good version and is reported";
  - "a file over 8 KB, a symlink, or a path outside the folder is refused";
  - "writing a file you changed since it was read is refused";
  - "your edit in an editor is indexed and logged as yours";
  - "search finds by name, description and text, quickly (500 files < 50 ms)";
  - "the index is rebuilt from the files";
  - "history keeps each change and the text before";
  - "old notes move to files once, even if interrupted".
- [ ] FAIL → implement → PASS → commit `feat: memory is a folder of files, indexed and logged in SQLite`.

### Task 2: Chats and ions use memory through ion's tools

**Files:** `apps/daemon/src/mcp/tools.ts` and `ion-tools.ts` (the tools below, for runs and ions), `packages/schema/src/ion-tools.ts`, `apps/daemon/src/ions/instructions.ts`, the runs' instructions (`apps/daemon/src/runs`), `apps/cli/src/commands/memory.ts`, CLI help golden on purpose.

- **Tools:**
  - `memory_index { type?, status? }` returns one line per file the caller may see: name, description, type, scope, and for to-dos the status and due date. Ordered: open to-dos first, then by last change. Capped at 200 lines.
  - `memory_search { q }` (FTS) returns the same lines, best match first, at most 20.
  - `memory_read { name or path }` returns the file's text, wrapped as data.
  - `memory_write { scope, name, description, type, text, see?, status?, due?, expect? }` creates a file, or updates one when `expect` (the hash from `memory_read`) matches.
  - `memory_forget { name }`.
  
  Every call enforces "who sees what" and "who writes what". A file the caller may not see doesn't exist for it: no name, no "not allowed".
- **What's loaded up front:** a chat's first message gets its index (the files it may see, at most 40 lines; "more with memory_search"). An ion's turn gets its own. Details are read only when needed.
- **Instructions,** one line each:
  - "look in memory before asking the user something you may already know";
  - "keep one topic per file; update a file rather than adding a near-copy";
  - for chats: "write what the next chat in this project should know".
- **CLI:**
  - `ion memory ls [-p project] [--type] [--open]`;
  - `ion memory show <name>`;
  - `ion memory search <q>`;
  - `ion memory forget <name>`;
  - `ion memory open`, which opens the folder.
- [ ] Tests:
  - "a chat sees its project's files and your shared ones, never another project's or your ions-only files";
  - "a chat can't write your person files";
  - "an ion's turn starts with its index";
  - "memory_read wraps the text as data";
  - "an update with an old hash is refused";
  - "writes are limited per turn and run";
  - "the CLI lists, shows, searches and forgets".
- [ ] FAIL → implement → PASS → live (opencode, Grok): a chat writes a project fact, and a new chat in that project finds it with memory_search. Ion chief reads your preference before answering → commit `feat: chats and ions find and keep memory through ion's tools`.

### Task 3: To-dos are memory files

**Files:** `apps/daemon/src/memory/todos.ts`, `apps/daemon/src/ions/*` (briefing, instructions), `apps/daemon/src/scheduler` (reminders), `apps/cli/src/commands/todo.ts`, tests next to each.

- A to-do is a memory file with `type: todo`, `status`, and an optional `due`.
- **Ions add one when it's clear you mean it:** "remind me to…", "later we need to…", or a thread whose last message lists what's left. The chat says so in one line: "Added to your to-dos: rotate the keys (Friday)". Chats can add to-dos for their project the same way.
- **Ion chief's briefing** starts with what's due today or overdue, then the rest of what's open. A to-do with a `due` gets one reminder that morning, through the scheduler, posted in ion chief's thread.
- **When a chat finishes work that matches an open to-do** (the ion judges, using the index), the ion offers "Mark done?" with Done / Not yet. It never closes one on its own. You can close any to-do yourself.
- **CLI:** `ion todo [ls]`, `ion todo add "<text>" [-p project] [--due date]`, `ion todo done <name>`.
- [ ] Tests:
  - "remind me to … becomes a to-do with its date";
  - "the briefing lists due and overdue first";
  - "a due to-do is reminded once that morning";
  - "a finished chat that matches a to-do offers Mark done, and doesn't close it";
  - "ion todo adds, lists and closes".
- [ ] FAIL → implement → PASS → live (Grok): tell ion chief "remind me to update the README on Friday", see the to-do and its line; finish a storefront chat that updates the README, and see "Mark done?" → commit `feat: to-dos live in memory, and ion chief keeps you on them`.

### Task 4: Memory in the app

**Files:** `apps/desktop/src/settings/Memory*.tsx` (a new Settings page, Memory, between Ions and Tools), the Ions screen (an ion's to-dos), `apps/desktop/src/chats` (the "Added to your to-dos" line), the lab (`renderMemory`), `docs/README.md`, `AGENTS.md`.

- **Settings → Memory:**
  - A scope picker: You, then each project.
  - Rows show an icon by type, the name, the description, who changed it last (you, a chat by its title, an ion), when, and a "Shared with chats" switch for your files.
  - Search at the top (FTS).
  - Clicking a row shows its text, read-only, with Open (in your editor), History (each change and who made it, with Restore), and Forget.
  - The page has **Open memory folder** and the broken-file line.
- **To-dos:** an icon tab on the Memory page for open to-dos (with due dates), Done, and Forget; ion chief's screen shows the count.
- Words: plain, no hint text; icons named on hover.
- [ ] Tests:
  - "Memory lists by scope and searches";
  - "a row shows who changed it and when";
  - "Shared with chats changes see";
  - "History restores an older text";
  - "to-dos show due dates and close";
  - lab parity.
- [ ] FAIL → implement → PASS → tour (Memory at 1440×900 and 900×700, a broken file, History and Restore, a to-do) → commit `feat: Memory in Settings, with history and your to-dos`.

### Task 5: Tour, docs, and verify end to end

- `scripts/tour.sh` seeds memory files (yours and a project's; one broken; two to-dos, one due today), so a fresh tour shows every state.
- Live (opencode free model and Grok; Claude only if needed), reading the daemon log and chat events afterwards:
  - plain chats keep and find project memory;
  - ion chief and a project ion see what they should and nothing more;
  - a to-do from "remind me…" is reminded and offered as done;
  - your edit in an editor shows up in the app and in chats;
  - old notes migrate.
- Docs: `docs/README.md`, `AGENTS.md` (the memory folder and its rules), and the walkthrough artifact refreshed with Memory screenshots, never real personal memory.
- [ ] Run → fix what fails (each fix with a failing test first) → commit `test: memory and to-dos checked end to end`.
