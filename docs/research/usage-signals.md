# Usage signals: what each agent reports

Plan 20 (usage-aware agents). ion keeps what each agent really reports about its usage and limits, and nothing it
doesn't. Probed on 2026-11-22 on this machine. No account details, keys or tokens were printed or kept: only field
names, units and the kind of sign-in.

| Agent | Version | Tokens per run | Cost per run | Limit windows (gauge) | Limit failure | Reset time | Billing (from sign-in) |
|---|---|---|---|---|---|---|---|
| Codex | codex-cli 0.153.2 | yes | no | yes: 5 h and week | `usageLimitExceeded` | from the full window | ChatGPT: subscription; API key: api |
| Claude Code | 2.1.326 (Agent SDK 0.3.326) | yes | yes (`total_cost_usd`) | yes: 5 h and week | `rate_limit_event` `rejected` | `resetsAt` | claude.ai or long-lived token: subscription; API key or cloud: api |
| opencode | 1.18.8 | when ACP reports it | `usage_update.cost` | no | its log line, or an error, "Free usage limit reached" | none | free only on a model it prices at 0, else unknown |
| Grok Build | 1.0.92 | yes (`_meta`) | yes (`_meta.usage.costUsdTicks`) | no (over ACP) | not seen | not seen | subscription (Sign in with Grok) |

## Codex

- **Source:** `codex app-server generate-ts` (the protocol's TypeScript types, codex-cli 0.153.2), then a probe of
  `account/read` and `account/rateLimits/read` over `codex app-server` (no model call).
- **Windows:** `account/rateLimits/read` returns `{ rateLimits: RateLimitSnapshot, rateLimitsByLimitId }`, where
  `RateLimitSnapshot = { limitId, limitName, primary, secondary, credits, planType, rateLimitReachedType, … }` and
  each window is `RateLimitWindow = { usedPercent: number, windowDurationMins: number | null, resetsAt: number | null }`.
  `resetsAt` is unix seconds. Probed: `primary` is 300 minutes (5 h), `secondary` 10080 minutes (week), with
  `limitId: "codex"` and the plan type (`plus`).
- **Updates:** the server also sends `account/rateLimits/updated` (`{ rateLimits: RateLimitSnapshot }`, a sparse
  rolling update). ion takes those during a turn and reads `account/rateLimits/read` once at the turn's end (at most
  3 s); a Codex without the method reports no windows.
- **Tokens:** `thread/tokenUsage/updated` → `tokenUsage.last.{inputTokens,outputTokens}` per model call (ion adds them
  up per turn). No cost.
- **Limit:** a turn's error `codexErrorInfo: "usageLimitExceeded"` (`rateLimitExceeded` is a short rate limit, retried).
  `rateLimitReachedType` says which (`rate_limit_reached`, `workspace_*_usage_limit_reached`, credits depleted). The
  reset is the full window's `resetsAt`.
- **Billing:** `account/read` → `account.type` `chatgpt` (plan) or `apiKey`; `codex login status` says
  "Logged in using ChatGPT" or an API key. ChatGPT: `subscription`; API key: `api`.

## Claude Code

- **Source:** the Agent SDK's types (`SDKRateLimitInfo` in `sdk.d.ts`, 0.3.326) and one tiny real run
  (`claude -p … --model haiku --output-format stream-json --verbose`, 2026-11-22).
- **Windows:** each request sends a `rate_limit_event` with `rate_limit_info`. The SDK's type has
  `{ status: "allowed" | "allowed_warning" | "rejected", resetsAt?, rateLimitType?: "five_hour" | "seven_day" | …,
  utilization?, … }`. The real CLI also sends `unifiedWindows` (not in the SDK's type):
  `{ five_hour: { utilization: 0.03, resetsAt, status }, seven_day: { utilization: 0.64, resetsAt, status } }`.
  `utilization` is a fraction (0–1), `resetsAt` unix seconds. ion keeps `five_hour` (5 h) and `seven_day` (week);
  the recorded transcripts in `fixtures/transcripts/claude-code/2.1.326` carry them too.
- **Per-model weekly windows:** the SDK's `rateLimitType` also names `seven_day_opus`, `seven_day_sonnet` and
  `seven_day_overage_included` (a weekly cap on one model family, or with overage). ion shows only `five_hour` and
  `seven_day`; a rejected per-model window still counts as a limit by its `resetsAt` (the run's error), but has no
  gauge of its own.
- **Lag:** the windows are your whole plan's (claude.ai, the desktop app, other machines), as of the last request ion
  made. Use outside ion moves them without ion seeing it until its next run: the week window can lag what you've used.
  A gauge older than its reset is dropped; one that's merely old isn't refreshed until the agent runs again.
- **Tokens and cost:** the `result` message: `usage.input_tokens`, `usage.output_tokens`, `total_cost_usd` (what the
  run would cost at API prices; on a subscription it isn't billed).
- **Limit:** `rate_limit_info.status: "rejected"`. With `resetsAt` more than 2 minutes away it's the usage limit
  (`usage_limit`, not retried), with its reset; nearer, a rate limit retried after `resetsAt`. A rejected `five_hour`
  or `seven_day` window with no `resetsAt` is the limit with no reset. The CLI's own text for it reads like
  "You've hit your limit · resets 4pm"; ion goes by the structured event, not the words.
- **Billing:** `claude auth status --json` → `authMethod`: `claude.ai` and `oauth_token` are the Claude plan
  (`subscription`); `api_key`, `api_key_helper` and `third_party` are paid per token (`api`; ion doesn't run on them).

## opencode

- **Source:** a tiny run over ACP (`opencode acp --print-logs --log-level WARN`, 2026-11-22) and PR #28's failure line.
- **Limit:** out of its free quota, opencode says so only in its log, then retries quietly:
  `level=ERROR message="stream error" providerID=opencode modelID=big-pickle session.id=… error.error="AI_APICallError:
  Free usage limit reached. …"`. No reset time anywhere. ion's `logGiveUp` ends the turn at once and reports it as
  the limit with no reset (`limit: {}`): limited for 30 minutes, then one more try.
- **Usage:** `session/update` `usage_update` (`used`, `size`, `cost.amount`), and the prompt result's `usage` when the
  ACP version has it. No windows.
- **Billing:** `opencode models <provider> --verbose` lists each model with `cost.input` and `cost.output` (per million
  tokens). Zen's free models (`opencode/big-pickle`, `opencode/*-free`) are priced at 0; OpenCode Go's and provider
  models list a price. ion asks it about the models it really ran on opencode this week (each run's `model`), else the
  ones ion is set to run there (its default `opencode/big-pickle`, ion's quick/deep/judge models and projects' on
  opencode): `free` only when every one is priced 0/0, else unknown (a Go plan and a provider key both list a price,
  and ion can't tell which bills), shown as "Learned from errors" with this week's cost when opencode reported one,
  never as free.
- **Limit as an error:** when opencode's prompt fails with "… usage limit reached" (its own wording above), the
  turn's error is the limit (`usage_limit`, no reset), not a retried rate limit; a bare 429 is still a rate limit.

## Grok Build

- **Source:** a tiny run over ACP (`grok --permission-mode default agent stdio`, 2026-11-22), `grok usage --help`, and
  its ACP `initialize` (auth methods).
- **Tokens and cost:** the prompt result's `_meta`: `inputTokens`, `outputTokens`, and `_meta.usage.costUsdTicks`
  (1e-10 USD each: 532540000 ticks = $0.053 for a 28k-token turn, which matches its price). Grok also sends
  `_x.ai/session_notification` `turn_completed` with the same usage.
- **Windows:** none over ACP. `grok usage` prints "your plan's usage limit" only with its background service
  ("can't show your plan's usage here yet. Run /usage inside grok instead" otherwise), so ion doesn't read it.
- **Limit:** not seen (no limit hit while probing). ion learns it from errors when it comes.
- **Billing:** its ACP auth methods are `cached_token` (from `grok login`) and `grok.com` ("Sign in with Grok"): a
  Grok plan, `subscription`.

## What a run's total counts (estimates)

A run's `totalTokens` is every token it processed: input with the cached context it read and wrote, and output.
ion's estimates ("usually 40–120k tokens") add these up per chat. When an agent's count is known to be partial, the
run has no total and that agent never shows a token estimate. Checked 2026-11-23:

| Agent | Total | Why |
|---|---|---|
| Claude Code | `input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens` of the `result` | `input_tokens` leaves out cached context: the fixture `denied.jsonl` is 4 + 28,858 + 48,864 + 702 = 78,428, not 706. |
| Codex | `inputTokens + outputTokens`, summed over the turn's `tokenUsage.last` | Codex's `inputTokens` already include `cachedInputTokens` (a part of them). |
| Grok Build | `_meta.inputTokens + outputTokens` | Its `_meta` counts the whole turn (its cost in ticks matches that count at its price). |
| opencode | none | Probed with opencode 1.18.8 (big-pickle), one ACP turn of 5 steps (4 tool calls). The prompt result's `usage` (`inputTokens` 357, `cachedReadTokens` 13,568, `outputTokens` 32, `totalTokens` 13,957) is only the last step. Its one `usage_update` (`used` 13,925) is the last step's context. `opencode export` shows the 5 steps were 13,278 + 13,484 + 13,705 + 13,811 + 13,957 = 68,235. ACP gives no per-step counts, so ion keeps no total for opencode. |

## What ion does with them

- Each adapter emits `usage.reported` with `inputTokens`, `outputTokens`, `costUsd` and, where the agent reports them,
  `windows: [{ name, usedPercent, resetsAt }]`. A run that reports none clears the agent's last windows: a gauge never
  stays frozen at an old value; "Learned from errors" shows instead.
- A limit failure is an `error` with `limit: { resetsAt? }` (there is no `run.failed` event: a failed run is an
  `error` then `run.finished { status: "failed" }`). The usage view marks the agent limited until the reset, or for
  30 minutes when there's none; a second thread hitting the same limit meanwhile doesn't add a mark or push it later.
  A run that started after the mark and ends well clears it. A limit is never retried in place.
- ions count too (the user, 2026-11-22): ion chief's and the project ions' turns, the dream, the judge and ion's quick
  model report the same `usage.reported` and limit `error`, stamped with the agent (`harness`) and kept off any chat,
  so an agent's line includes what ions spend, and a limit an ion hits marks the agent for everyone. An ion whose
  agent is limited goes on the next ready one that isn't, and its reply says so in one line: "On Grok Build — Claude
  Code is limited until 16:00" (checked live: opencode out of free usage, ion chief answered on Grok).
- A limit ion guessed (no stated reset) isn't trusted blindly: with no other agent free, an ion tries that agent anyway
  (one turn), and a chat's handoff offers it as "may be free again". With every ready agent limited by a stated reset,
  an ion says which frees up first ("Claude Code is limited until 16:00") instead of "I couldn't reach my agent". A
  run or ion turn that started after a mark and ended well clears it.
- Billing comes from each adapter's sign-in check (`AuthStatus.billing`); unknown stays unknown and is never shown as
  free.
- A reset an agent states is checked before ion marks or waits on it (security scan, 2026-11-23): one that isn't a
  date or is past is unknown; it's believed only within the agent's longest reported window (Codex's or Claude's
  week), or 6 hours for an agent that reports none. Later than that it counts as ion's guess (tried after 30 minutes),
  and it never pushes a stated mark later. A wake-up the scheduler refuses falls back to the guess.
- At a limit (Plan 20 Task 2), ion holds the chat and asks: Continue on the next free agent in your order, Wait for
  the reset, or Always continue on it here. The question comes at once (it doesn't wait on a slow agent's first sign-in
  check) and `ion ask` shows it before it exits. Continue starts a new run in the same worktree with ion's brief (your
  request, the files changed, the last steps and error, "check git status and the tests"); the chat shows one line.
- Pick by usage (Task 3, off at first) picks a new chat's agent from these signals: never a limited one; room in its
  windows first, then what fits, then subscription and free before api, then your order; with one line of why.
- Estimates (Task 4) come from `totalTokens` of similar past chats in the project (at least 5), shown as cost for an
  agent paid per use, a share of a window when the agent reports one, else tokens.

## Checked end to end (2026-11-23)

- opencode (big-pickle): its free quota didn't run out this time, so the limit came from the fake agent and was
  handed to Grok Build for real: "Continued on Grok Build — Fake hit its limit"; Grok ran `git status` first, found the
  earlier step had changed nothing, made the change and said so. A file opencode or Grok made shows as added.
- Grok Build: no windows and no limit over ACP still. A tiny chat (one file, one line) cost $0.09–$0.17; with a
  handoff brief and a few checks, $0.36 (about 41k input tokens). Five such chats in one project gave "usually
  31k–42k tokens".
- Pick by usage, with nothing limited: "On opencode — free and enough for this".
