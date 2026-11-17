# @ion/client

Typed WebSocket client for the daemon, used by the CLI and (later) the desktop app.

```ts
const info = readDaemonInfo(dataDir);            // { pid, port, token } from daemon.json, or null
const ion = await connect({ port: info.port, token: info.token });
await ion.call("projects.add", { path: "/code/storefront" });
const stop = await ion.subscribe({ chatId }, (event) => render(event));
```

Errors from the daemon reject with `ApiCallError` (`code`: `unknown_command` | `bad_request` | `invalid` | `internal`).
