import type { IonEvent } from "@ion/schema";
import type { EventStore } from "../store/index.js";

/** Every stored event after the cursor, read page by page so nothing is cut off. */
export function readBacklog(
  store: EventStore,
  q: { chatId?: string; afterId?: string; fromNow?: boolean },
  pageSize = 1000,
): IonEvent[] {
  if (q.fromNow === true) return [];
  const out: IonEvent[] = [];
  let after = q.afterId;
  for (;;) {
    const page = store.read({ chatId: q.chatId, afterId: after, limit: pageSize });
    out.push(...page);
    if (page.length < pageSize) return out;
    after = page[page.length - 1]!.id;
  }
}
