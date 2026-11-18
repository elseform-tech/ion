import { EV, type IonCard, type IonEvent } from "@ion/schema";

/** One thing an ion's chat shows: your message, or the ion's line with its card if it has one. */
export type IonItem = { kind: "you"; text: string } | { kind: "ion"; text: string; card?: IonCard };

/** An ion's chat (its events on "ion:<ionId>") as what it shows, in order. Pure. */
export function ionTimeline(events: IonEvent[]): IonItem[] {
  return events.flatMap((e): IonItem[] => {
    const d = e.data as { text?: string; card?: IonCard };
    if (e.type === EV.ionHeard) return [{ kind: "you", text: d.text ?? "" }];
    if (e.type === EV.ionSaid)
      return [{ kind: "ion", text: d.text ?? "", ...(d.card ? { card: d.card } : {}) }];
    return [];
  });
}
