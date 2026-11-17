# @ion/adapter-kit

The contract every harness adapter implements, and a shared test suite that proves it.

- `HarnessAdapter`: `detect()`, `auth.status()` / `auth.login()`, `capabilities()`, `start(opts)` → `Session`.
- `StartOpts.decide(req)`: the daemon answers every permission prompt (policy now, "Needs you" pins later).
- `AdapterEvent`: an adapter event without chat or run ids; the daemon stamps those.
- `createEventQueue()`: a push-based async queue for session event streams.
- `StartOpts.resume`: the harness's own session id to continue; an adapter that can't throws `ResumeFailed` and the
  daemon starts a new session with the chat's history instead. `StartOpts.mcp`: ion's MCP server for the run.
- `cachedCatalog(load, { fallback })` / `capabilitiesWith(base, catalog)`: a harness's model list read from the
  harness, kept 10 minutes; a load that fails or takes over 10 s gives the fallback (`modelsLive: false`).
- `@ion/adapter-kit/contract` → `describeAdapterContract(name, make, scenarios)`: call it from an adapter's tests.
  It checks run start/finish, valid adapter-only events, finished tools, no file change on deny, interrupt within 5 s.
