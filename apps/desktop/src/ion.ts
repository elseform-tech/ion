import { connectBrowser, type IonClient } from "@ion/client/browser";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";
import { type ConnState, type DaemonInfo, IonConnection } from "./connection.js";

const inTauri = () => "__TAURI_INTERNALS__" in window;

/**
 * Where the daemon is: from the app (Tauri reads daemon.json). Only in a development build opened in a plain
 * browser (`vite`, used by the end-to-end check), from `?port=&token=`; a release build never reads the URL.
 */
async function daemonInfo(): Promise<DaemonInfo | null> {
  if (inTauri()) return invoke<DaemonInfo | null>("daemon_info");
  if (!import.meta.env.DEV) return null;
  const q = new URLSearchParams(window.location.search);
  const port = Number(q.get("port"));
  const token = q.get("token");
  return port && token ? { port, token } : null;
}

/**
 * Starts ion when it isn't running (Plan 21 audit, 2026-11-23: the app opened on a terminal command): only the app
 * can, through its shell; a browser keeps the command.
 */
async function startIon(): Promise<boolean> {
  return inTauri() ? invoke<boolean>("start_daemon").catch(() => false) : false;
}

const connection = new IonConnection({
  info: daemonInfo,
  connect: (i) => connectBrowser(i),
  ...(inTauri() ? { start: startIon } : {}),
});

/** The app's connection to ion: its state, and the client while it's up. */
export function useIon(): { state: ConnState; client: IonClient | null } {
  useEffect(() => {
    connection.start();
    return () => connection.stop();
  }, []);
  const state = useSyncExternalStore(connection.subscribe, () => connection.state);
  return { state, client: state === "up" ? connection.client : null };
}
