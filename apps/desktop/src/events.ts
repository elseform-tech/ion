import type { IonClient } from "@ion/client/browser";
import type { IonEvent } from "@ion/schema";
import { useEffect } from "react";

/** Hears ion's events from now on while mounted, `fn` for each (a new `fn` hears from then on). */
export function useEvents(client: IonClient, fn: (e: IonEvent) => void): void {
  useEffect(() => {
    let stop: (() => void) | undefined;
    let gone = false;
    void client
      .subscribe({ fromNow: true }, (e) => {
        if (!gone) fn(e);
      })
      .then(
        (s) => {
          if (gone) s();
          else stop = s;
        },
        () => {},
      );
    return () => {
      gone = true;
      stop?.();
    };
  }, [client, fn]);
}
