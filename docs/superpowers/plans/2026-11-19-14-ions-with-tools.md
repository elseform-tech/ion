# Plan 14: Ions With Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ion chief and each project's ion think as real agent sessions, with ion's own tools, their agent's read-only tools and real effort, so they answer accurately, route among 20+ projects, and ask "Which project?" when unsure.

**Architecture:** An ion's turn becomes a harness session (not a bare call): it runs on the ion's agent and model at its effort, with a per-turn MCP key of a new kind ("ion") whose tools see exactly the projects that ion may see, and a gate that allows only reading. Its last message is the reply; threads it starts through a `start_thread` tool become the reply's thread lines. Each ion keeps its agent session between turns (resume), so it remembers the conversation.

**Tech Stack:** TypeScript, the daemon's MCP server (`@modelcontextprotocol/sdk`), adapter-kit `StartOpts`, Vitest; live evals on Grok.

**Spec:** the user, 2026-11-19 (this conversation): "ions require tools, reasoning and their harness power… rather than cheap and quick, i would rather it finishes task accurately, securely, with high quality with some cost"; "can ion chief scale if there are 20+ projects, how would ion manage to find the right project for the right query or ask-mes?"; "we can encourage the harness to chain bash commands more often rather than executing tools in parallel or one by one to scale tools and also save cost". Design lab: `docs/design/ion-design-lab.html` (Ions screens). Memory: `ions-full-power`.

## Global Constraints

- AGENTS.md walls and code health (80 lines per function, cognitive 15, 4 params, ratchet may not worsen); `pnpm check && pnpm build` before each commit.
- No real model calls in tests; live checks are opt-in (`ION_LIVE_GROK=1`), Grok and opencode first, Claude only when needed.
- An ion never edits files, never runs a command that changes anything, never reaches outside the projects it may see. Everything from chats, memory, READMEs or agents reaches an ion as `wrapData(...)` data.
- ion chief sees only projects with `shareWithIon !== false`, never `default`; a project's ion sees only its project.
- Ions' sessions run in Auto with ion's own gate; there is no Full access for an ion.
- UI copy: short plain words, no hint text; every UI PR runs the tour (`scripts/tour.sh`).
- Fixed values: at most 5 threads per ion turn (`MAX_ROUTES`); a turn's hard limit is 5 minutes (`ION_TURN_MS = 300_000`); a project profile is at most 300 characters; `projects` returns at most 10 matches.

## Review Focus

1. A project kept from ion chief (`shareWithIon = false`) asked about by name → chief can't see it through any tool, and says it can't.
2. An ion's agent tries to edit a file or run `rm`/`git push`/`npm install` → denied by the ion gate; the turn goes on and the reply says what it could not do.
3. Two messages to the same ion in quick succession → the second waits for the first turn (one session per ion at a time), never two sessions resuming the same native id.
4. The ion's agent isn't signed in, or the turn hits 5 minutes → the ion says so in one plain line ("I couldn't reach my agent; try again."), nothing hangs on "Thinking".
5. 22 projects, a message naming none clearly ("fix the login bug") → chief asks which project, offering the 2–3 likeliest, instead of starting a thread in a guess.

---

## File Structure

- Create `apps/daemon/src/ions/turn.ts`: runs one ion turn as a harness session (start or resume, MCP key, gate, effort, timeout), returns `{ reply, threads, nativeId }`.
- Create `apps/daemon/src/ions/instructions.ts`: the standing instructions for ion chief and for a project's ion.
- Create `apps/daemon/src/ions/profiles.ts`: a project's profile (config value, else its README's first paragraph) and `rankProjects`.
- Create `apps/daemon/src/mcp/ion-tools.ts`: the tools an ion's key opens.
- Modify `apps/daemon/src/mcp/grants.ts`: scope gains `kind: "run" | "ion"`, `ionId`, `projects`.
- Modify `apps/daemon/src/mcp/server.ts`: register run tools or ion tools by the key's kind.
- Modify `apps/daemon/src/ions/service.ts`: `chief`/`project`/`report` call the turn; drop the JSON prompts.
- Delete the JSON paths in `apps/daemon/src/ions/route.ts` and `project.ts` (`chiefPrompt`, `parseRoute`, `projectPrompt`, `parseProjectDecision`, `reportPrompt`, `reportOf`); keep `contextOf`, `projectContextOf`, `plainReport`.
- Modify `apps/daemon/src/views/ions.ts`: keep each ion's agent and native session id.
- Modify `apps/daemon/src/runs/instructions.ts`: chained read-only commands.
- Modify `packages/config/src/user-config.ts`: `projects[].profile`.
- Modify `packages/adapters/fake/src/scenarios.ts`: an `ion` scenario that calls ion tools over MCP.
- Modify `apps/desktop/src/ions/IonChat.tsx`, `ionTimeline.ts`: an ion's work shows as a work line above its reply.
- Modify `apps/desktop/src/settings/IonPage.tsx`: the project's profile, editable.
- Test files next to each.

### Task 1: Ion keys and ion tools

**Files:** Modify `apps/daemon/src/mcp/grants.ts`, `apps/daemon/src/mcp/server.ts`; Create `apps/daemon/src/mcp/ion-tools.ts`, `apps/daemon/src/ions/profiles.ts`; Modify `packages/config/src/user-config.ts`; Test `apps/daemon/src/mcp/ion-tools.test.ts`, `apps/daemon/src/ions/profiles.test.ts`.

**Interfaces:**
- Produces: `type Scope = RunScope | IonScope`; `RunScope = { kind: "run"; projectId; chatId; runId }` (today's shape plus `kind`); `IonScope = { kind: "ion"; ionId: string; projects: string[]; turnId: string }`. `grants.create(scope, keyKind?)`, `grants.revoke(id)` revokes by `runId` or `turnId`.
- Produces: `registerIonTools(server, scope: IonScope, d: Deps & { startThread: (projectId: string, brief: string, turnId: string) => Promise<{ chatId: string } | { why: string }> })`.
- Produces: `profileOf(project: ProjectEntry): string` (config `profile`, else README's first paragraph, else ""; at most 300 chars, control characters stripped); `rankProjects(query: string, projects: { id; name?; profile; titles: string[] }[]): string[]` (ids, best first, at most 10; word overlap with name, profile and recent chat titles, ties by recent activity).
- Config: `profile: z.string().max(300).optional()` on Project.

Ion tools (all results `wrapData`; every project argument checked against `scope.projects`, else "Not allowed"):
`projects {query?}` (id, name, profile, status line from `contextOf`; with a query, `rankProjects` order), `search_chats {query, projectId?}`, `chat_history {chatId}`, `open_needs {projectId?}`, `memory_list {projectId?}` (you + allowed projects), `memory_write {text}` (ion chief: scope "you"; a project's ion: its project; 5 per turn), `decisions {projectId}`, `set_profile {text}` (project ion only, its project), `start_thread {projectId, brief}` (at most 5 per turn; `default` refused).

- [ ] **Step 1: Tests** in `ion-tools.test.ts`: "ion chief's key lists only projects shared with ion, never default" (a `private` project with `shareWithIon: false` absent from `projects` and refused by `search_chats {projectId: "private"}` with "Not allowed"); "a project's ion sees only its project" (its key refuses another project's `chat_history`); "start_thread starts at most 5 threads a turn and refuses default"; "memory_write writes you-memory for ion chief and project memory for a project's ion"; "a run's key opens no ion tools and an ion's key no run tools" (`tools/list` names). In `profiles.test.ts`: "profile is the config's, else the README's first paragraph, at most 300 characters"; "rankProjects puts the project whose profile matches first" (22 projects, query "cart checkout" → `storefront` first).
- [ ] **Step 2:** Run `pnpm -s vitest run apps/daemon/src/mcp apps/daemon/src/ions/profiles.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3:** Implement as the Interfaces say; `server.ts` registers `registerTools` for `kind: "run"` and `registerIonTools` for `kind: "ion"`.
- [ ] **Step 4:** Run the same; Expected: PASS. Then `pnpm check`.
- [ ] **Step 5:** Commit `feat: ion keys and ion tools (projects with profiles, lookups, start_thread)`.

### Task 2: The ion gate: reading only

**Files:** Modify `apps/daemon/src/runs/policy.ts` (or create `apps/daemon/src/ions/gate.ts`); Test `apps/daemon/src/ions/gate.test.ts`.

**Interfaces:**
- Produces: `decideForIon(req: ApprovalRequest, c: { roots: string[]; home: string; ionDirs: string[] }): "allow" | "deny"`: ion's own MCP tools (`mcp__ion__*` / `ion__*`) allow; `ruleFor` allow (read-only commands, reads and searches inside `roots`) allow; everything else deny. Never asks, never calls the judge.

- [ ] **Step 1: Tests**: "an ion may read and search its project and run read-only chained commands" (`cat README.md && ls src` allow); "an ion may never edit, write, install, push or reach outside" (`Write`, `sed -i`, `npm install`, `git push`, `cat ~/.ssh/id_rsa` → deny); "an ion's other MCP servers are denied".
- [ ] **Step 2:** Run; Expected FAIL.
- [ ] **Step 3:** Implement on top of `ruleFor` (Plan 05) and `decideByPolicy`'s ion-tool check.
- [ ] **Step 4:** PASS; `pnpm check`.
- [ ] **Step 5:** Commit `feat: an ion's gate allows reading only`.

### Task 3: One ion turn as a session

**Files:** Create `apps/daemon/src/ions/turn.ts`, `apps/daemon/src/ions/instructions.ts`; Modify `apps/daemon/src/views/ions.ts`; Test `apps/daemon/src/ions/turn.test.ts`.

**Interfaces:**
- Consumes: Task 1 grants and `registerIonTools`, Task 2 `decideForIon`, `getHarness`, `defaultAgent`.
- Produces: `class IonTurns { constructor(d: { store; db; configFile; grants; mcpUrl: () => string; gateUrl: () => string; agents: () => Promise<HarnessInfo[]>; startThread }); turn(ionId: string, text: string): Promise<{ reply: string; threads: { chatId: string; projectId: string }[] }> }`. One turn at a time per ion (a per-ion promise chain). Session: `cwd` = ion chief: `<dataDir>/ions/chief` (made empty); a project's ion: its project's folder. `instructions` = `ionInstructions(ionId)`. `effort` = project `effort` ?? `[ion] quickEffort` ?? null; agent and model as `agentFor`/`brainOf` today; `resume` = the ion's stored native id when its agent is unchanged. Hard limit `ION_TURN_MS = 300_000`: interrupt, then reply "I couldn't finish that in time." Agent missing: reply "I couldn't reach my agent; try again."
- Produces: `ionsView.session(db, ionId): { harness: string; nativeId: string } | null`, recorded by an `ion.session` event `{ ionId, harness, nativeId }` (new event type in `packages/schema`, contract golden updated on purpose).
- Produces: the turn's tool events stored under chat `ion:<ionId>` with the turn's id as `runId` (`tool.started`, `tool.finished`, `thinking.delta`), so the app can draw its work.
- `ionInstructions(ionId: "chief" | string): string`: who it is; that it must look things up with its tools before answering; with more than 8 projects, call `projects` with a query; when no project clearly fits, ask the user which one, naming the 2–3 likeliest, and start nothing; start threads only for work in a repo; never edit; chain several read-only lookups into one command with `&&`; reply plainly in a few sentences.

- [ ] **Step 1: Tests** (fake agent, `ION_ALLOW_FAKE=1`): "a turn's last message is the reply, and the threads it started come with it"; "a second message waits for the first turn" (Review Focus 3); "a turn resumes the ion's session"; "an agent that isn't signed in gives one plain line" and "a turn past its limit is stopped and says so" (Review Focus 4; inject `ION_TURN_MS` via a constructor option for the test); "an ion turn's edit is denied by its gate" (fake `ion` scenario tries a write; Review Focus 2).
- [ ] **Step 2:** Add the fake `ion` scenario in `packages/adapters/fake/src/scenarios.ts`: prompts whose instructions start with ion's ion instructions; it calls `projects`, then `start_thread` for each project named in the message ("please check <a> and <b>"), tries a write when the message says "try-edit", and replies "Asked <n> projects." or "This is <project>."
- [ ] **Step 3:** Run `pnpm -s vitest run apps/daemon/src/ions/turn.test.ts`; Expected FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** PASS; `pnpm check`; commit `feat: an ion's turn is a real agent session with ion's tools`.

### Task 4: Ions think through turns

**Files:** Modify `apps/daemon/src/ions/service.ts`, `route.ts`, `project.ts`, `apps/daemon/src/api/server.ts`; Test `apps/daemon/src/ions/ions.test.ts`, `apps/daemon/src/api/server.test.ts`.

**Interfaces:**
- Consumes: Task 3 `IonTurns`.
- `Ions` takes `turns: Pick<IonTurns, "turn">` instead of `quick`. `message(ionId, text)`: `turn` → `say(ionId, reply, threads.length ? { kind: "threads", threads } : undefined)`; each started thread also gets "From ion: <brief>" in its project's ion chat (as today). `report(...)` asks the project's ion (and ion chief when it started the thread) through a turn: "Thread <title> ended: <status>. Tell the user what came of it." Fallback without an agent: `plainReport`.
- The JSON prompts and parsers named in File Structure are deleted with their tests; their behaviours move to `turn.test.ts`/`ions.test.ts`.

- [ ] **Step 1:** Rewrite the ion tests to a `turns` stub (`vi.fn(async () => ({ reply, threads }))`): "ion chief's reply and its threads are one message with thread lines"; "a project's ion answers about its project without a thread"; "a thread's end is reported by its ion, and by ion chief when ion chief started it"; "without an agent, the report is the agent's own reply". Server test: "ion chief routes with the fake agent through start_thread" (end to end over MCP).
- [ ] **Step 2:** FAIL; **Step 3:** implement; **Step 4:** PASS, `pnpm check && pnpm build`.
- [ ] **Step 5:** Commit `feat: ions think as agent sessions with tools`.

### Task 5: Chained commands for runs and ions

**Files:** Modify `apps/daemon/src/runs/instructions.ts`, `apps/daemon/src/ions/instructions.ts`; Test `apps/daemon/src/runs/manager.test.ts`, `apps/daemon/src/ions/turn.test.ts`.

- [ ] **Step 1:** Tests: the run instructions and the ion instructions contain "&&" guidance ("When you need several read-only lookups, chain them in one command with &&").
- [ ] **Step 2:** FAIL; **Step 3:** add one sentence to each; **Step 4:** PASS; commit `feat: agents chain read-only lookups into one command`.

### Task 6: The app: an ion's work, and project profiles

**Files:** Modify `apps/desktop/src/ions/ionTimeline.ts`, `IonChat.tsx`, `apps/desktop/src/settings/IonPage.tsx`, `apps/daemon/src/api/settings.ts` (`profile` in `PATCHABLE`, at most 300 chars), `docs/design/ion-design-lab.html` (an ion's work line above its reply); Test `apps/desktop/src/ions/Ions.test.tsx`, `apps/desktop/src/settings/Settings.test.tsx`.

- [ ] **Step 1:** Tests: "an ion's tool calls show as one work line above its reply, open to its steps" (reuses `WorkBlock`); "Settings shows and saves a project's profile" (`project.update {profile}`; over 300 chars refused with "Keep it under 300 characters").
- [ ] **Step 2:** FAIL; **Step 3:** implement; **Step 4:** PASS; tour at 1440×900 and 900×700; commit `feat: an ion's work shows in its chat; project profiles in Settings`.

### Task 7: Live evals with 22 projects

**Files:** Modify `apps/daemon/src/evals/live.test.ts`; `docs/research/acp-and-harnesses.md`.

- [ ] **Step 1:** Add, gated by `ION_LIVE_GROK=1`: 22 small repos with READMEs (storefront: cart and checkout; payments-api: totals and webhooks; billing; mobile-app; docs; and 17 more distinct ones); ion chief on Grok. Checks: "routes 'the cart drawer total is wrong' to storefront only"; "routes 'webhook retries' to payments-api"; "answers 'what's waiting on me' without a thread"; "asks which project for 'fix the login bug' when two projects have login, starting nothing" (Review Focus 5); "can't see or route to a project kept from it" (Review Focus 1).
- [ ] **Step 2:** Run `ION_LIVE_GROK=1 pnpm -s vitest run apps/daemon/src/evals/live.test.ts -t "22 projects"`; Expected: all pass; record results in the doc.
- [ ] **Step 3:** Real app: message ion chief and a project's ion, watch the work line, open a thread, read the daemon log. Commit `test: live evals: ion chief across 22 projects`.
