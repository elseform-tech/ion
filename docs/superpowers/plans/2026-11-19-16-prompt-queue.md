# Plan 16: Prompt Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While a chat's agent or an ion is working, you can queue your next messages; they wait in line above the message box, each with Send now, Edit and Remove, and go out one by one as the work ends.

**Architecture:** The daemon keeps each chat's and each ion's queue as events (`queue.added`, `queue.removed`, `queue.sent`), so it survives the app closing. When a run finishes (a chat) or a turn ends (an ion, Plan 14), the next queued message is sent. Send now interrupts the chat's run (an ion's turn: stops it) and sends that message next.

**Tech Stack:** TypeScript, the daemon's event store and views, React.

**Spec:** the user, 2026-11-19: "there is no stop (double esc) for both plain chat and ions"; "include hotkey for queuing prompt request so that user can queue request (with push now icon, edit icon, remove icon)"; "even for ions, maybe?". Depends on Plan 14 (ion turns, one at a time per ion).

## Global Constraints

- Hotkeys (the user, 2026-11-19: "enter for queue when the thread is still running, and command + enter for push right now"): while the chat's agent or the ion is working, Enter queues the message and ⌘Enter (Ctrl+Enter elsewhere) sends it now; when nothing is working, Enter sends as today. Esc twice stops the work (chats have it already; ions get it here).
- Icons only (named on hover): Send now (`ArrowUp`), Edit (`Pencil`), Remove (`X`). No hint text.
- At most 10 queued messages per chat or ion ("That's 10 waiting already").
- A queued message keeps the brain (agent, model, effort, access) picked when it was queued.
- The desktop keeps no state of its own (lint): the queue lives in the daemon.
- `pnpm check && pnpm build`; tour before the PR; no real model calls in tests.

## Review Focus

1. A run fails while messages wait → the next one is still sent (a failure doesn't stall the queue).
2. ion stops and starts again with messages waiting → they're still listed and go out after the next run or turn ends.
3. Edit a queued message while it's being sent → the edit loses the race safely: the box gets the text back only if it wasn't sent ("Already sent").
4. Send now with three waiting → that one goes next, the others keep their order.
5. A chat archived with messages waiting → its queue is cleared.

---

### Task 1: The daemon's queue

**Files:** Create `apps/daemon/src/queue/index.ts`, `apps/daemon/src/views/queue.ts`; Modify `packages/schema/src/events.ts` (`queue.added {queueId, to: {chatId} | {ionId}, text, brain}`, `queue.removed {queueId}`, `queue.sent {queueId}`), `packages/schema/src/api.ts` (`queue.list {to} → QueuedInfo[]`, `queue.add {to, text, brain} → {queueId}`, `queue.remove {queueId}`, `queue.take {queueId} → {text}` (for Edit), `queue.sendNow {queueId}`), `apps/daemon/src/api/commands.ts`; contract golden on purpose. Tests next to each.

**Interfaces:** `class PromptQueue { add(to, text, brain): string; remove(queueId): void; take(queueId): { text: string }; sendNow(queueId): Promise<void>; drain(to): Promise<void> }`. `drain` sends the oldest waiting message through `runs.ask` (a chat) or `ions.message` (an ion); called on `run.finished` for the chat and when an ion's turn ends.

- [ ] Tests: "queues while a run goes, and sends the next when it finishes"; "keeps order; Send now goes next and interrupts the run"; "a failed run still sends the next" (Review Focus 1); "survives a restart" (Review Focus 2); "take returns the text and removes it, or refuses once sent" (Review Focus 3); "at most 10"; "archiving a chat clears its queue" (Review Focus 5); "an ion's queue goes out turn by turn".
- [ ] FAIL → implement → PASS → `pnpm check` → commit `feat: a queue for your next messages, per chat and per ion`.

### Task 2: The app

**Files:** Modify `apps/desktop/src/chats/Composer.tsx`, `apps/desktop/src/ions/IonChat.tsx` (IonBox), create `apps/desktop/src/chats/Queue.tsx`, `docs/design/ion-design-lab.html` (the queue above the message box); Test `apps/desktop/src/chats/Queue.test.tsx`.

- [ ] Tests: "Enter queues while the agent works, and sends when it doesn't"; "Esc twice stops an ion's turn, and it says it stopped" (needs `ion.stop {ionId}` → `IonTurns.stop(ionId)`, Plan 14, added to Task 1's API); "⌘Enter sends now"; "each queued line has Send now, Edit and Remove; Edit puts the text back in the box"; same for an ion's box.
- [ ] FAIL → implement → PASS → tour (queue three while `slow` runs; send one now; edit one; remove one) → real check on opencode's free model → commit `feat: queued messages above the message box`.
