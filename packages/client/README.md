# @ion/client

Typed WebSocket client for the daemon. `@ion/client` (Node, with `ws`) for the CLI and tests; `@ion/client/browser`
(`connectBrowser`, the browser's own WebSocket, no Node) for the desktop app. Both share one core.

```ts
const info = readDaemonInfo(dataDir);            // { pid, port, token } from daemon.json, or null
const ion = await connect({ port: info.port, token: info.token });
await ion.call("projects.add", { path: "/code/storefront" });
const stop = await ion.subscribe({ chatId }, (event) => render(event)); // its backlog, then live
await ion.subscribe({ fromNow: true }, onEvent);                        // live only
```

The token is sent as a WebSocket subprotocol (`ion.token.<token>`), never in the URL. Errors from the daemon reject with `ApiCallError` (`code`: `unknown_command` | `bad_request` | `invalid` | `internal`).
