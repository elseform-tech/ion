import type { IonClient } from "@ion/client/browser";
import { EV } from "@ion/schema";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { useEffect, useRef } from "react";

/** The stream the daemon puts system notifications on. */
const STREAM = "notify";

type Notice = { title: string; body: string; chatId?: string };

/** ion asked you once already (asked again only if asking failed). */
let asked = false;
/** The ask on screen now: every notification that comes meanwhile waits for your answer. */
let asking: Promise<boolean> | null = null;

/** Asks you, once: a failed ask can be asked again. */
function ask(): Promise<boolean> {
  asking ??= requestPermission().then(
    (answer) => {
      asked = true;
      asking = null;
      return answer === "granted";
    },
    (e: unknown) => {
      asking = null;
      throw e;
    },
  );
  return asking;
}

/** Whether ion may notify: checked each time (you may turn it on in the system's settings), asking you once. */
async function allowed(): Promise<boolean> {
  if (await isPermissionGranted()) return true;
  return asked ? false : ask();
}

async function show(n: Notice): Promise<void> {
  if (!(await allowed())) return;
  sendNotification({ title: n.title, body: n.body, ...(n.chatId ? { extra: { chatId: n.chatId } } : {}) });
}

/** A click on a notification: the window comes forward, then its chat opens. */
function forward(): void {
  const w = getCurrentWindow();
  void w
    .unminimize()
    .then(() => w.setFocus())
    .catch(() => {});
}

/**
 * ion's notify events, shown as system notifications; clicking one opens its chat. Only in the app's window: the
 * browser dev app has no system notifications.
 */
export function useSystemNotifications(client: IonClient | null, open: (chatId: string) => void): void {
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (!client || !("__TAURI_INTERNALS__" in window)) return;
    asked = false;
    asking = null;
    let gone = false;
    const stops: (() => void)[] = [];
    const keep = (stop: () => void) => (gone ? stop() : stops.push(stop));
    // A listener first: without one, a click on a desktop notification isn't reported.
    void onAction((e) => {
      const chatId = e.notification?.extra?.chatId;
      forward();
      if (typeof chatId === "string") openRef.current(chatId);
    }).then(
      (l) => keep(() => void l.unregister()),
      () => {},
    );
    void client
      .subscribe({ chatId: STREAM, fromNow: true }, (e) => {
        if (e.type === EV.notify) void show(e.data as Notice).catch(() => {});
      })
      .then(keep, () => {});
    return () => {
      gone = true;
      for (const stop of stops) stop();
    };
  }, [client]);
}
