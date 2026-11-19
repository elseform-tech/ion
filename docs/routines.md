# Routines and Activity (Plan 10)

A routine is something a project's ion does on a schedule. When it's due, the ion starts a thread for it, the same
way it does when you message it: a chat marked `by: "ion"`, always in Auto, on the ion's agent. The thread is titled
by the routine's name and briefed with its text.

## Where they live

In your config, under their project (`default` has no ion, so no routines):

```toml
[[projects]]
id = "storefront"
path = "/Users/you/code/storefront"

[[projects.routines]]
id = "morning-check"      # from the name; unique in the project
name = "Morning check"    # the thread's title
when = "weekdays 09:00"
text = "Run the tests and say what broke."
on = true
effort = "low"            # optional: else the project's effort
skip = "2026-11-20T08:00:00.000Z"   # optional: the one run you skipped

[routines]
paused = true             # optional: pause all
```

## When

Local time, one of four forms (`@ion/schema` `parseWhen`, `nextRun`; `@ion/config` checks the same format):

| Form | Runs |
|---|---|
| `daily 09:00` | every day at 9:00 |
| `weekdays 09:00` | Monday to Friday at 9:00 |
| `mon 09:00` … `sun 09:00` | that day each week |
| `every 4h` (1–23) | on the hours counted from midnight: 0:00, 4:00, 8:00… (`every 5h`: 0, 5, 10, 15, 20, then 0) |

`nextRun(when, from)` is the first slot strictly after `from`.

## How the daemon runs them

`apps/daemon/src/scheduler/routines.ts` looks once at start and then once a minute.

- Each slot runs at most once. Every slot handled is a `routine.ran` event (`due` is the slot), so a restart knows
  which ran.
- Slots missed while ion was stopped run once at start, as the latest of them, not once per slot.
- A routine that's off, or every routine while pause all is on, lets its slots pass. Turned back on (or added, or
  given a new time), it waits for its next slot.
- A skipped slot is recorded (`skipped: true`), and the skip leaves your config.
- When the thread can't start (no agent ready), `routine.ran` says why, and the ion says so in its chat.
- Run now (`routine.run`) starts it whatever its schedule (`by: "you"`, `due: null`). The schedule stays.

## Commands

`routine.add`, `routine.update` (any field; `skip: true` skips the next run, `false` undoes it), `routine.remove`,
`routine.run`, `routines.pause`, and `activity.list`: every routine's next run (soonest first, then the paused ones),
with its ion, project and effort, plus ion threads' runs today and yesterday (local days), each with its title, ion,
the routine that started it, how it ended, its cost and when it started.

## CLI

```
ion routines                         # list: id, project, when, next run
ion routines add "Morning check" -p storefront -w "weekdays 9:00" -d "Run the tests." [--effort low]
ion routines run morning-check       # -p when two projects have that id
ion routines remove morning-check
```

## App

- The Ions panel's Activity row: what runs next ("Next: storefront · 9:00"), or "No routines scheduled".
- The Activity page: Pause all; Upcoming, each with run now, skip next and pause; Today and Yesterday.
- An ion's Settings page: a Routines group, a row per routine (when, what it does, effort, next run, on/off,
  remove), and Add routine (name, when from a picker, what to do).
