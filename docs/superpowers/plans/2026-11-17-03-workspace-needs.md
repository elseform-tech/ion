# ion Workspace, Needs and Retries Implementation Plan (Plan 03)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every chat works in its own git worktree, so edits inside it are safe to allow; anything else becomes a "Needs you" item you answer once (CLI now, pins in the app later) instead of an automatic deny; runs queue under a concurrency limit; transient failures retry with backoff and jitter.

**Architecture:** `apps/daemon/src/workspace` owns worktrees (the only place that runs `git`). `apps/daemon/src/needs` turns policy "ask" decisions into `need.raised` events and waits for exactly one `need.resolved`. `apps/daemon/src/scheduler` queues runs (`run.queued` → `run.started`) under `resources.max_runs`. `apps/daemon/src/runs/retry.ts` wraps a run with the retry rule. Views: `view_needs`, `view_chats`.

**Tech Stack:** as Plan 02.

**Spec:** `docs/design/ion-design-lab.html` (Run and Need state machines, data flow "a message in a project chat", Decided: retries), `docs/architecture/contract.md` (Retries section).

## Global Constraints

- Everything from Plans 01–02 (walls, health ratchet, goldens, no model calls in CI, copy rules).
- Only `apps/daemon/src/workspace/**` runs `git` (already enforced by `ion/no-child-process`).
- Worktrees live at `<dataDir>/worktrees/<chatId>` on branch `ion/<chat-slug>-<6 hex>`, created from the project's current `HEAD`. ion never pushes, merges or deletes branches it didn't create.
- Policy (replaces Plan 02's): reads, searches and edits whose every path is inside the chat's worktree → allow; edits, commands, web or MCP otherwise → **ask** (a need); anything with no path for an edit → ask. `--allow-edits` is removed.
- A need resolves exactly once (`need.resolved` with `by: "you" | "ion"`); resolving is the only thing that resumes a paused run. Duplicate requests with the same `dedupeKey` (harness + tool + summary) in one chat merge into the open need.
- Retries (from the spec, exact): transient errors (`error.retryable: true`, rate limits, network, a crashed CLI) back off with full jitter: `delay = random(0, min(120 s, 2 s × 2^attempt))`, at most 4 tries, a `retryAfterS` on the error wins. A real task failure (non-retryable) gets one retry at the next effort level (`low→medium→high→max`), never above `max`.
- `resources.max_runs` from `config.toml` (`"auto"` = `max(1, floor(cores / 2))`).

## Review Focus

1. **Answering a need after the daemon restarted** → the run was interrupted by the restart (Plan 02 sweep), so the need resolves as `superseded` and the CLI says the run stopped; no dangling waiter. Test in Task 4.
2. **Two needs answered at once, or one answered twice** → the second answer gets `That's already answered`; the run resumes once. Test in Task 3.
3. **A worktree folder deleted by hand** → the next run in that chat recreates it from the branch (or reports `Worktree missing; start a new chat`), never runs in the main checkout. Test in Task 1.
4. **Retry storms** → a harness that fails every time stops after 4 tries with the last error shown; backoff delays are within the formula's bounds (test with a seeded random and a fake clock). Test in Task 6.
5. **Queue fairness** → with `max_runs: 1`, three asks run in order; interrupting a queued run removes it without starting it. Test in Task 5.

---

### Task 1: Worktrees

**Files:** Create `apps/daemon/src/workspace/{git.ts,worktrees.ts,index.ts}`; Test `apps/daemon/src/workspace/worktrees.test.ts`

**Interfaces:**
- `createWorktree(repo: string, dataDir: string, chatId: string, title: string): Promise<{ path: string; branch: string }>` (idempotent per chat: returns the existing one)
- `ensureWorktree(…same…)` — recreates from the branch when the folder is gone
- `removeWorktree(repo: string, path: string): Promise<void>` (keeps the branch)
- `git(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>` — no shell, `GIT_TERMINAL_PROMPT=0`
- [ ] Tests on temp repos: create → folder exists on branch `ion/<slug>-<hex>`; second call returns the same; folder removed by hand → `ensureWorktree` recreates it on the same branch; `removeWorktree` keeps the branch; a non-repo → `Not a git repository`.
- [ ] Commit `feat(daemon): one git worktree per chat`.

### Task 2: Events and views for needs and chats

**Files:** Modify `packages/schema/src/events.ts`, `api.ts`; Create `apps/daemon/src/views/{needs.ts,chats.ts}`; Tests, contract golden

**Interfaces:**
- Data: `need.raised { needId, requestId, kind, summary, detail: string | null, dedupeKey }`; `need.resolved { needId, decision: "allow" | "allow_always" | "deny" | "superseded", by: "you" | "ion" | "daemon" }`; `chat.created` gains `worktree: string | null, branch: string | null`; `run.queued {}`; `run.retrying { attempt: number, delayS: number, reason: string, effort: string | null }`
- Commands: `needs.list { chatId? } → NeedInfo[]`, `need.resolve { needId, decision }`, `chats.list → ChatInfo[]`, `chat.archive { chatId }`
- `view_needs(need_id, chat_id, run_id, status open|resolved, summary, kind, raised_at)`, `view_chats(chat_id, title, project_id, worktree, branch, archived, last_run_status)`
- [ ] Schema tests per payload; view tests incl. rebuild-equals-live; contract golden diff shows only the new types/commands.
- [ ] Commit `feat(schema,daemon): needs and chats`.

### Task 3: Needs service

**Files:** Create `apps/daemon/src/needs/{service.ts,index.ts}`; Test `service.test.ts`

**Interfaces:**
- `class NeedsService { raise(r: { chatId; runId; requestId; kind; summary; detail?; dedupeKey }): Promise<Decision>; resolve(needId: string, decision: Decision, by: "you" | "ion"): void; supersedeRun(runId: string): void; open(chatId?: string): NeedInfo[] }`
- `raise` appends `need.raised` (or joins an open need with the same `dedupeKey` in the chat) and resolves when `need.resolved` for it is stored.
- [ ] Tests: raise → open list has it → resolve → promise resolves with the decision, list empty; resolve twice → `UserError("That's already answered")`; dedupe merges two raises into one need, both waiters resolve; `supersedeRun` resolves its open needs as `superseded` (waiters get `deny`).
- [ ] Commit `feat(daemon): needs service`.

### Task 4: Policy and run manager use worktrees and needs

**Files:** Modify `apps/daemon/src/runs/{policy.ts,manager.ts}`, `apps/daemon/src/api/commands.ts`; Tests `policy.test.ts`, `manager.test.ts`

- [ ] `decideByPolicy(req, { roots }) → "allow" | "ask"`; the manager turns `ask` into `needs.raise`; `approval.resolved.by` becomes `"policy"` or `"you"`.
- [ ] New chats get a worktree (Task 1); runs use it as `cwd`; `chat.archive` removes it and marks the chat archived.
- [ ] Shutdown and the crash sweep call `supersedeRun`.
- [ ] Tests with the fake adapter: `approve` → need raised, run paused → resolve allow → `file.changed` in the worktree, not in the main checkout; resolve deny → no change; restart (sweep) → need superseded; edits inside the worktree are allowed without a need.
- [ ] Commit `feat(daemon): worktree runs and needs instead of auto-deny`.

### Task 5: Run queue

**Files:** Create `apps/daemon/src/scheduler/{queue.ts,index.ts}`; Modify `manager.ts`, `packages/config` (`resources.max_runs`); Test `queue.test.ts`

- [ ] `createRunQueue(limit: number)` → `{ enqueue(start: () => Promise<void>): { id, cancel() }; size(): number }`; FIFO; a cancelled queued item never starts.
- [ ] `ask` appends `run.queued`, then `run.started` when the queue starts it; `run.interrupt` on a queued run → `run.finished interrupted` without starting the harness.
- [ ] Tests: limit 1, three asks run in order; cancel a queued one; `max_runs: "auto"` → `max(1, floor(cores/2))`.
- [ ] Commit `feat(daemon): run queue with a concurrency limit`.

### Task 6: Retries

**Files:** Create `apps/daemon/src/runs/retry.ts`; Modify adapters to set `retryable` and `retryAfterS` where they know (Claude `rate_limit_event`/API errors, ACP RPC transport errors, crashed CLI); Test `retry.test.ts`

- [ ] `backoffDelay(attempt: number, random: () => number, retryAfterS?: number): number` per the constraint; `nextEffort(e)`.
- [ ] The manager wraps each run: transient → `run.retrying` + new session after the delay (max 4 tries); a real failure → one retry at the next effort; a retry is a new session in the same worktree, with the original text.
- [ ] Tests: delays within bounds over 1,000 seeded draws; retry-after wins; a fake that fails transiently twice then succeeds ends `done` with two `run.retrying`; always failing stops after 4 with the last error; a non-retryable failure retries once at the next effort; `max` doesn't go higher.
- [ ] Commit `feat(daemon): retries with backoff and jitter`.

### Task 7: CLI — needs, chats, waiting runs

**Files:** Create `apps/cli/src/commands/{needs.ts,chats.ts}`; Modify `render.ts`, `ask.ts`; Tests + golden

- [ ] `ion needs` → one line per open need: `<id>  <project>  <summary>`; `ion needs allow|deny <id>`; `ion chats` (title, project, branch, last status); `ion chats archive <id>`.
- [ ] `ion ask` shows `· Waiting on you: <summary> — run: ion needs allow <id>` while paused, and `· Retrying in 4s (rate limit)`.
- [ ] Remove `--allow-edits` (the worktree makes edits safe; a golden diff shows it).
- [ ] Commit `feat(cli): needs and chats`.

### Task 8: Docs, end to end

- [ ] READMEs (daemon workspace/needs/scheduler), AGENTS.md, docs index.
- [ ] End to end on opencode's free model (temp `ION_HOME`, scratch repo): an edit lands in the worktree branch, the main checkout is untouched; a shell command raises a need; `ion needs allow` resumes it; `ion chats archive` removes the worktree. Grok Build: one need round-trip. No Claude calls unless the Claude adapter changes.
- [ ] Commit `docs: workspace, needs, retries`.
