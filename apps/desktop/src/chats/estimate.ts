import type { IonClient } from "@ion/client/browser";
import { type Commands, estimateText } from "@ion/schema";
import { useEffect, useState } from "react";

type Ask = Commands["usage.estimate"]["args"];

/** How long typing settles before ion is asked. */
const SETTLE_MS = 400;

/** A started chat's estimate, once asked (it doesn't change while the window is open). */
const kept = new Map<string, string | null>();

/**
 * What a task usually takes, in words ("usually 40–120k tokens"), from your past chats; null when there are too few
 * to say, or nothing to ask (`ask` null). Shown only on hover (the user, 2026-11-21: quietly). A started chat's is
 * asked once.
 */
export function useEstimate(client: IonClient, ask: Ask | null): string | null {
  const key = ask ? JSON.stringify(ask) : "";
  const [text, setText] = useState<string | null>(() => kept.get(key) ?? null);
  useEffect(() => {
    setText(kept.get(key) ?? null);
    if (!key || kept.has(key)) return;
    let live = true;
    const t = setTimeout(() => {
      Promise.resolve(client.call("usage.estimate", JSON.parse(key) as Ask)).then(
        (e) => {
          const said = e ? estimateText(e) : null;
          if ("chatId" in (JSON.parse(key) as Ask)) kept.set(key, said);
          if (live) setText(said);
        },
        () => {},
      );
    }, SETTLE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [client, key]);
  return text;
}
