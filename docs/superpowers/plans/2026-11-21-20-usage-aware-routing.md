# Plan 20: Usage-Aware Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ion knows how much each agent has used and has left, and how each one bills. It picks a thread's agent with that in mind and says why in one line. When an agent hits its limit mid-thread, ion offers to hand the work to another agent, carrying a brief of what's done and what's left.

**Architecture:**
- **Agents report usage; ion keeps it.** Each adapter emits what its agent reports: tokens, cost, and rate-limit windows where the agent exposes them. ion stores these in a usage ledger (an event + a view in `apps/daemon/src/store`).
- **Limits are learned, never guessed.** When an agent fails on a limit, the adapter classifies the error. ion marks the agent "limited until <reset>" if the error says when, else for a cautious default.
- **A pure policy picks the agent.** The routing policy lives in `packages/policy` (no I/O). It takes the candidates (fit, your preference, headroom, how they bill, estimate) and returns a choice and a one-line reason.
- **Handoff is a new run.** It runs in the same worktree, on another agent, from a brief ion writes from the chat's events. Agents can't resume each other's sessions.

**Tech Stack:** TypeScript, the adapters' usage/limit signals, SQLite views, `packages/policy`, React.

**Spec:** the user, 2026-11-21: "do you think it is possible for ion to have provider cost and usage aware before figuring what provider to use for the worker thread, like figuring out how much quota or usage is left for each harness or cost estimate for the tasks before choosing harness for the thread to run on, and even figuring out a thread have reached rate limit and figuring a way to perform task handoff" → "sure" (to this plan, in the order: ledger and limits, handoff asking first, routing, estimates). Standing preference: save Claude quota; opencode and Grok first; Claude only when needed.

## Global Constraints

- **Signals are optional per agent.** Use what an agent really reports, recorded in `docs/research/usage-signals.md` with the source (docs, a probe, `--help`). If a signal disappears in a new agent version, ion falls back to "learned from errors" and never shows a made-up gauge.
- **How an agent bills** comes from its sign-in, as one of:
  - `subscription`: no extra cost until the limit;
  - `api`: paid per token;
  - `free`: no cost, limits opaque.
  
  It's shown as one word. An unknown sign-in is never shown as `free`.
- **Nothing is sent anywhere.** Usage stays local, like the rest of ion's data.
- **You decide handoffs by default:** "<Agent> hit its limit (resets 16:00). Continue on <Other>, or wait?" Continue / Wait / Always continue on <Other> here. An automatic handoff happens only after you chose "Always" for that project, or globally.
- **Routing never overrides a thread's agent you picked.** Routing only fills in when nothing was picked. Project ions' agent choices stay the default unless you turn on "Pick by usage" (Settings → Agents, off by default at first).
- Copy rules, lab parity, code health, tests first, no real model calls in tests, live checks on opencode's free model and Grok (Claude only if needed), tour before the PR.

## Review Focus

1. An agent whose limit message has no reset time: ion marks it limited for a cautious default (30 min). It retries once after that, and never loops on retries.
2. A limit hit mid-edit: the handoff brief tells the next agent to check the worktree's state (`git status`, the tests) before continuing. The next agent never assumes the last edit finished.
3. Two threads hitting the same agent's limit at once: one "limited" mark, and each thread asks you once. No handoff storm.
4. A gauge from an agent that stops reporting: it disappears and is replaced by "Learned from errors", never frozen at an old value.
5. A handoff whose target agent is also limited: it's offered only agents that aren't limited. With none left, "Wait" is the only choice, with the earliest reset.

---

### Task 1: The usage ledger and limits, shown in Settings

**Files:** each adapter (`packages/adapters/*`) emits `usage.reported` (extend: `inputTokens`, `outputTokens`, `costUsd?`, `windows?: [{ name, usedPercent, resetsAt }]`) and classifies limit failures (`run.failed` gains `limit?: { resetsAt? }`); `packages/schema` (contract golden on purpose); `apps/daemon/src/views/usage.ts` (per agent: today, 7 days, last windows, limited-until); `apps/daemon/src/api/usage.ts`; `apps/desktop/src/settings/Agents.tsx`; `ion status`; `docs/research/usage-signals.md`.

- **Probe each agent's real signals first** and record them:
  - Codex: rate-limit snapshots in its token-count events — check the field names on the installed version;
  - Claude Code: cost and tokens per run, and its limit error's wording and reset;
  - opencode: free-quota errors through its log (Plan 18's failure line);
  - Grok: per-run usage and its limit errors.
- **Settings → Agents shows one line per agent:**
  - "Codex · 62% of 5 h · resets 14:20";
  - "Claude Code · limited until 16:00";
  - "opencode · Free";
  - plus this week's cost for `api`-billed agents.
- `ion status` shows the same.
- [ ] Tests:
  - "a Codex window snapshot is stored and shown";
  - "a limit error marks the agent limited until its reset";
  - "no reset → limited for 30 min, then one retry";
  - "a missing gauge shows Learned from errors";
  - "billing comes from the sign-in".
- [ ] FAIL → implement → PASS → live (Codex if signed in, opencode, Grok) → commit `feat: ion keeps each agent's usage and limits, and shows them`.

### Task 2: Handoff when an agent hits its limit

**Files:** `apps/daemon/src/runs/handoff.ts` (new), `apps/daemon/src/runs/manager.ts`, `apps/daemon/src/needs` (the question), `apps/desktop/src/chats` (the handoff line), the lab.

- **When a run fails on a limit,** ion holds the chat and asks: "<Agent> hit its limit (resets 16:00). Continue on <Other>, or wait?" The choices are Continue, Wait, and Always continue on <Other> here. Only agents that aren't limited are offered.
- **Continue** starts a new run in the same worktree, on the other agent, with a handoff brief built from the chat's events:
  - your request;
  - what was done (the files changed, from the worktree diff);
  - the last steps and the last error;
  - what's left, if the agent said so;
  - "check git status and the tests before continuing".
  
  The chat shows one line: "Continued on Codex — Claude hit its limit".
- **The same brief for long chats starting fresh (the user, 2026-11-22: "sure").** Whenever ion has to start a new session for a chat — another agent, a session that can't resume, or one that failed because its context got too long (apps/daemon/src/runs/manager.ts freshText) — and the chat's history is too long for the new agent's context (a budget per agent, e.g. about 50% of its window, measured in characters/4 until tokens are known), ion sends the handoff brief plus the last few messages verbatim instead of the whole transcript. Short chats keep the full history as today. The chat shows "Started fresh with a summary" once.
- **Wait** re-queues the chat for the reset time, using the scheduler.
- [ ] Tests:
  - "a limit asks Continue or Wait";
  - "Continue starts the other agent in the same worktree with the brief";
  - "Always continues without asking next time";
  - "a limited target isn't offered";
  - "Wait resumes at the reset";
  - "two threads on one limit ask once each";
  - "a long chat starting fresh gets the brief and its last messages, not the whole transcript";
  - "a short chat still gets its full history".
- [ ] FAIL → implement → PASS → live (force a limit with a fake agent's limit error, then a real hand-over from opencode to Grok) → commit `feat: when an agent hits its limit, ion offers to hand the work to another`.

### Task 3: Pick the agent by usage and cost

**Files:** `packages/policy/src/route.ts` (pure: `pickAgent(candidates, task) → { agent, reason }`), `apps/daemon/src/ions` (when an ion starts a thread), `apps/daemon/src/runs` (new chats with no agent picked), Settings → Agents ("Pick by usage", off at first), the composer (the reason on hover).

- **Candidates are signed-in agents that aren't limited.** They're weighed in this order:
  1. **Fit:** the ion's quick/deep model choice, and the project's agent.
  2. **Your preference:** save Claude unless the task needs it.
  3. **Headroom:** Codex's windows; others from recent errors.
  4. **Billing:** subscription and free before api.
- **The reason is one line:** "On Codex — Claude is near its limit", or "On opencode — free and enough for this". It shows in the thread line and the chat header.
- **Two settings in Settings → Agents (the user, 2026-11-22: "sure"):**
  - **Agent order:** a drag list (default opencode, Grok Build, Codex, Claude Code). It is the one preference list used by handoff targets, Pick by usage, and an ion's chats when the project names no agent. It replaces the order fixed in code.
  - **"When an agent hits its limit":** Ask (default) / Continue on the next agent / Wait. "Always continue on X here" decisions still win for their project.
- **Your chats never wait (the user, 2026-11-22: the limit shouldn't stop you working in more chats, especially plain ones):**
  - Chats you send, plain or coding, start right away and never count toward a limit.
  - The limit applies only to work ion starts on its own: chats ions start and routines. The setting is renamed "Chats ion runs at once" (Auto = half the cores, or 1–32; still resources.max_runs).
  - A queued ion chat says why: "Waiting — 4 ion chats running".
  - Tests: "your chat starts even when ion's slots are full"; "ion-started chats and routines wait for a slot".
- [ ] Tests (pure policy):
  - "a limited agent is never picked";
  - "Claude is saved unless deep work needs it";
  - "near a window's end, another agent is picked";
  - "api-billed comes after subscription and free";
  - "your pick always wins";
  - "the agent order decides handoff targets and routing";
  - "your chat starts even when ion's slots are full".
- [ ] FAIL → implement → PASS → live → commit `feat: ion picks a thread's agent by usage and cost, and says why`.

### Task 4: Estimates from history

**Files:** `apps/daemon/src/views/usage.ts` (per project and kind of task: median and p90 tokens from past chats), the policy's `task.estimate`, the composer and thread line ("usually 40–120k tokens").

- The estimate is a range from similar past chats in that project (same agent family, similar request length, edit vs question). With fewer than 5 similar chats, there's no estimate rather than a guess.
- For `api`-billed agents, it's shown as cost ("usually $0.20–$0.60"). Otherwise it's shown as share of the window ("usually 5–10% of 5 h").
- [ ] Tests:
  - "no estimate with under 5 similar chats";
  - "the range comes from the project's history";
  - "api shows cost, subscriptions show share".
- [ ] FAIL → implement → PASS → tour → commit `feat: ion estimates a task from your past chats`.

### Task 5: Tour, docs, verify end to end

- `scripts/tour.sh` seeds usage, a limited agent, a handoff, and an estimate.
- Live checks:
  - a real limit on opencode's free model handed to Grok;
  - routing picks and explains;
  - Settings and `ion status` show the gauges.
- Docs: `docs/README.md`, `AGENTS.md`, the walkthrough artifact.
- [ ] Run → fix what fails (each fix with a failing test first) → commit `test: usage, limits and handoff checked end to end`.
