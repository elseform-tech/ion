import type { IonClient } from "@ion/client/browser";
import { type Commands, estimateText } from "@ion/schema";
import { useEffect, useState } from "react";

type Ask = Commands["usage.estimate"]["args"];

/** How long typing settles before ion is asked. */
const SETTLE_MS = 400;

/**
 * What a task usually takes, in words ("usually 40–120k tokens"), from your past chats; null when there are too few
 * to say, or nothing to ask (`ask` null). Shown only on hover (the user, 2026-11-21: quietly).
 */
export function useEstimate(client: IonClient, ask: Ask | null): string | null {
  const [text, setText] = useState<string | null>(null);
  const key = ask ? JSON.stringify(ask) : "";
  useEffect(() => {
    setText(null);
    if (!key) return;
    let live = true;
    const t = setTimeout(() => {
      Promise.resolve(client.call("usage.estimate", JSON.parse(key) as Ask)).then(
        (e) => live && setText(e ? estimateText(e) : null),
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
