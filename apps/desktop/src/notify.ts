import type { IonClient } from "@ion/client/browser";
import { EV } from "@ion/schema";
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

/** Whether you let ion notify: asked once, the first time there's something to show. */
let allowed: Promise<boolean> | null = null;
const ask = () =>
  (allowed ??= isPermissionGranted().then(async (yes) => yes || (await requestPermission()) === "granted"));

async function show(n: Notice): Promise<void> {
  if (!(await ask())) return;
  sendNotification({ title: n.title, body: n.body, ...(n.chatId ? { extra: { chatId: n.chatId } } : {}) });
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
    allowed = null;
    let gone = false;
    const stops: (() => void)[] = [];
    const keep = (stop: () => void) => (gone ? stop() : stops.push(stop));
    // A listener first: without one, a click on a desktop notification isn't reported.
    void onAction((e) => {
      const chatId = e.notification?.extra?.chatId;
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
