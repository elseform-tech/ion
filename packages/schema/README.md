# @ion/schema

The contract every other package depends on. Imports nothing but zod.

- `EVENT_TYPES`, `ADAPTER_EVENT_TYPES`, `DAEMON_EVENT_TYPES`, `isDaemonOnly(type)`
- `IonEvent`, `NewEvent`, `parseEvent(x)` (throws on invalid), `dataSchemas`
- `Capabilities`, `EffortLevel`
- Wire protocol for the daemon API (`api.ts`)

Event types are defined only here. Elsewhere, import them; the `ion/event-types-from-schema` lint rule
rejects string literals.
