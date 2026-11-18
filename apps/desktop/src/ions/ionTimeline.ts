import { EV, type IonCard, type IonEvent } from "@ion/schema";

/** One thing an ion's chat shows: your message, or the ion's line with its card if it has one. */
export type IonItem =
  | { kind: "you"; text: string }
  /** `answered`: your answer to its suggestion card (keep or not), once you've given it. */
  | { kind: "ion"; text: string; card?: IonCard; answered?: boolean };

/** An ion's chat (its events on "ion:<ionId>") as what it shows, in order. Pure. */
export function ionTimeline(events: IonEvent[]): IonItem[] {
  const answers = new Map(
    events
      .filter((e) => e.type === EV.suggestionAnswered)
      .map((e) => [(e.data as { suggestionId: string }).suggestionId, (e.data as { keep: boolean }).keep]),
  );
  return events.flatMap((e): IonItem[] => {
    const d = e.data as { text?: string; card?: IonCard };
    if (e.type === EV.ionHeard) return [{ kind: "you", text: d.text ?? "" }];
    if (e.type !== EV.ionSaid) return [];
    const answered = d.card?.kind === "suggest" ? answers.get(d.card.suggestionId) : undefined;
    return [
      {
        kind: "ion",
        text: d.text ?? "",
        ...(d.card ? { card: d.card } : {}),
        ...(answered !== undefined ? { answered } : {}),
      },
    ];
  });
}
