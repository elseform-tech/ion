# Plan 15: Workspace Artifacts and Processes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A chat's workspace panel lists the artifacts its agent made and every process its tool calls left running, background ones included, wherever they run.

**Architecture:** Each harness process ion starts carries `ION_CHAT=<chatId>` in its environment; children (and background processes they leave) inherit it, so ion finds them by that marker instead of by working folder. Artifacts are the files the chat created or changed since its first run (including ignored outputs such as screenshots and builds), newest first, each opening in Preview.

**Tech Stack:** TypeScript, `ps` / `/proc`, git, React.

**Spec:** the user, 2026-11-19: "the workspace preview should also list artifacts and running processes especially background processes from tool calls". Earlier: "a preview box on the right of the chat for the workspace: files, artifacts, background tasks with their PIDs, the diff" (2026-11-18).

## Global Constraints

- Child processes only in `apps/daemon/src/workspace`, adapters, `packages/adapter-kit` (AGENTS.md walls).
- Only your own processes are read; a PID is re-checked right before Stop (as `stopTask` does today).
- Previews stay as today: plain files only, at most 1 MB, never outside the worktree for files.
- At most 200 artifacts listed; `.git` and `node_modules` never listed.

## Review Focus

1. A dev server started with `cd /tmp/x && npm run dev &` (outside the worktree) → listed under the chat, with its port; Stop works.
2. A process of another chat, or of yours outside ion, → never listed.
3. The run has ended but its background server still runs → still listed until it stops.
4. A screenshot written to an ignored folder (`out/shot.png`) → listed as an artifact and previews as an image.
5. A PID reused by another program after the task ended → Stop refuses ("That isn't running in this chat").

---

### Task 1: Processes by chat marker

**Files:** Modify `packages/adapter-kit/src/types.ts` (`StartOpts.env?: Record<string, string>`), each adapter's spawn (`packages/adapters/acp/src/connection.ts`, `codex/src/connection.ts`, `claude-code` SDK `env`), `apps/daemon/src/runs/manager.ts` (passes `{ ION_CHAT: chatId }`), `apps/daemon/src/workspace/tasks.ts`; Test `apps/daemon/src/workspace/tasks.test.ts`, each adapter's start test.

**Interfaces:** `listTasks(worktree: string, chatId: string): Promise<Task[]>`: processes whose environment has `ION_CHAT=<chatId>` (macOS `ps -E -o pid=,command=` for your own processes; Linux `/proc/<pid>/environ`), plus today's cwd matches, minus ion's own; `Task` gains `where: string` (its working folder). `stopTask(worktree, chatId, pid)` re-checks both.

- [ ] **Step 1:** Tests: "lists a background process started elsewhere by the chat's agent" (`sh -c 'cd $TMP && sleep 30 &'` with `ION_CHAT=c1`); "never lists another chat's process"; "stops one, and refuses a PID that isn't the chat's". Adapter tests: "passes ion's env to the agent process".
- [ ] **Step 2:** FAIL; **Step 3:** implement; **Step 4:** PASS, `pnpm check`; commit `feat: a chat's processes, wherever its tool calls left them`.

### Task 2: Artifacts

**Files:** Modify `apps/daemon/src/workspace/tasks.ts` (or create `artifacts.ts`), `apps/daemon/src/api/workspace.ts` (`chat.artifacts`), `packages/schema/src/api.ts` (`ArtifactInfo = { path; size; changedAt; kind: "image" | "html" | "text" | "binary" }`, contract golden on purpose); Test next to each.

**Interfaces:** `listArtifacts(worktree: string, since: string): Promise<ArtifactInfo[]>`: files under the worktree modified at or after `since` (the chat's first run), ignored ones included, `.git`/`node_modules` skipped, symlinks not followed, newest first, at most 200.

- [ ] **Step 1:** Tests: "lists files the chat made, ignored outputs too, newest first"; "skips .git, node_modules and links out of the worktree"; "stops at 200".
- [ ] **Step 2:** FAIL; **Step 3:** implement; **Step 4:** PASS; commit `feat: a chat's artifacts`.

### Task 3: The panel

**Files:** Modify `apps/desktop/src/chats/ToolsPanel.tsx`, `Preview.tsx` (Artifacts tab with an icon, between Files and Preview; Tasks rows show `where` when it isn't the worktree), `docs/design/ion-design-lab.html`; Test `apps/desktop/src/chats/Preview.test.tsx`.

- [ ] **Step 1:** Tests: "the Artifacts tab lists the chat's files newest first and opens one in Preview"; "a task started elsewhere shows where it runs".
- [ ] **Step 2:** FAIL; **Step 3:** implement; **Step 4:** PASS; tour; real check on opencode's free model ("start a dev server in the background and write a screenshot"); commit `feat: the workspace panel lists artifacts and every running process`.
