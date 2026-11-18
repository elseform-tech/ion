import { createClient, type IonClient, protocols } from "./core.js";

export { ApiCallError, type IonClient } from "./core.js";

type BrowserSocket = {
  send(text: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
};

/**
 * Opens an authenticated connection to the daemon from a browser (the desktop app): the browser's own
 * WebSocket, no Node. `WebSocket` can be swapped in tests.
 */
export function connectBrowser(opts: {
  port: number;
  token: string;
  WebSocket?: new (url: string, protocols: string[]) => BrowserSocket;
}): Promise<IonClient> {
  const Ctor =
    opts.WebSocket ?? (globalThis.WebSocket as unknown as new (u: string, p: string[]) => BrowserSocket);
  const ws = new Ctor(`ws://127.0.0.1:${opts.port}/`, protocols(opts.token));
  const messages = new Set<(t: string) => void>();
  const closes = new Set<() => void>();
  ws.onmessage = (e) => {
    for (const fn of messages) fn(String(e.data));
  };
  ws.onclose = () => {
    for (const fn of closes) fn();
  };
  return new Promise((resolve, reject) => {
    ws.onerror = () => reject(new Error("ion isn't running"));
    ws.onopen = () =>
      resolve(
        createClient({
          send: (t) => ws.send(t),
          close: () => ws.close(),
          onMessage: (fn) => void messages.add(fn),
          onClose: (fn) => void closes.add(fn),
        }),
      );
  });
}
