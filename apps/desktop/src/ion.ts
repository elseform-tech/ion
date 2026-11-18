import { connectBrowser, type IonClient } from "@ion/client/browser";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";
import { type ConnState, type DaemonInfo, IonConnection } from "./connection.js";

const inTauri = () => "__TAURI_INTERNALS__" in window;

/**
 * Where the daemon is: from the app (Tauri reads daemon.json). Opened in a plain browser (development and the
 * end-to-end check), from `?port=&token=` instead; inside the app the URL is never used.
 */
async function daemonInfo(): Promise<DaemonInfo | null> {
  if (inTauri()) return invoke<DaemonInfo | null>("daemon_info");
  const q = new URLSearchParams(window.location.search);
  const port = Number(q.get("port"));
  const token = q.get("token");
  return port && token ? { port, token } : null;
}

const connection = new IonConnection({ info: daemonInfo, connect: (i) => connectBrowser(i) });

/** The app's connection to ion: its state, and the client while it's up. */
export function useIon(): { state: ConnState; client: IonClient | null } {
  useEffect(() => {
    connection.start();
    return () => connection.stop();
  }, []);
  const state = useSyncExternalStore(connection.subscribe, () => connection.state);
  return { state, client: state === "up" ? connection.client : null };
}
