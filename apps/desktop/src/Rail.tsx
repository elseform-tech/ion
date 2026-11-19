import type { IonClient } from "@ion/client/browser";
import { Avatar, MessageSquare } from "@ion/design-system";
import { EV } from "@ion/schema";
import { useEffect, useState } from "react";

export type Mode = "chats" | "ions";

/** How many questions wait for you, kept live (for the dot on Ions). */
export function useNeedCount(client: IonClient | null): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!client) return;
    let gone = false;
    let stop: (() => void) | undefined;
    const read = () =>
      void client.call("needs.list", {}).then(
        (n) => !gone && setCount(n.length),
        () => {},
      );
    read();
    void client
      .subscribe({ fromNow: true }, (e) => {
        if (e.type === EV.needRaised || e.type === EV.needResolved) read();
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
  }, [client]);
  return count;
}

/**
 * The lab's rail: the window's own buttons in its top strip, Chats, then Ions as the transparent orbit glyph (a
 * dot on it when something needs you), then you.
 */
export function Rail(p: { mode: Mode; setMode: (m: Mode) => void; initial: string; needs: number }) {
  const on = (m: Mode) => `rb${p.mode === m ? " on" : ""}`;
  return (
    <nav className="rail" aria-label="App">
      <div className="lights" aria-hidden="true" data-tauri-drag-region />
      <button className={on("chats")} type="button" title="Chats" onClick={() => p.setMode("chats")}>
        <MessageSquare />
      </button>
      <button
        className={on("ions")}
        type="button"
        title="Ions"
        aria-label="Ions"
        onClick={() => p.setMode("ions")}
      >
        <Avatar ion={p.mode === "ions" ? "glyph-on" : "glyph"} />
        <i className="dotb" hidden={p.needs === 0} />
      </button>
      <span className="grow" />
      <span className="me" title="You">
        {p.initial}
      </span>
    </nav>
  );
}
