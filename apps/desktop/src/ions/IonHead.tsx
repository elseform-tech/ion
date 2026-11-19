import { List } from "@ion/design-system";
import type { ChatInfo, IonInfo } from "@ion/schema";
import { useRef, useState } from "react";
import { useDismiss } from "../chats/dismiss.js";
import { relTime } from "../chats/live.js";
import { IonAvatar, IonName } from "./IonAvatar.js";

/** The chats an ion started (ion chief: every ion's), newest first. */
const startedBy = (ion: IonInfo, chats: ChatInfo[]) =>
  chats.filter((c) => c.by === "ion" && !c.archived && (ion.ionId === "chief" || c.projectId === ion.ionId));

/** The lab's ion header: its avatar and name, then the chats it started, one click away. */
export function IonHead(p: { ion: IonInfo; chats: ChatInfo[]; onOpenChat: (chatId: string) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useDismiss(open, wrap, () => setOpen(false));
  const mine = startedBy(p.ion, p.chats);
  const label = `Chats started by ${p.ion.name}`;
  return (
    <header className="head" data-tauri-drag-region>
      <IonAvatar ion={p.ion} />
      <IonName ion={p.ion} className="title" />
      <span className="sp" />
      {mine.length > 0 && (
        <div className="pwrap" ref={wrap}>
          <button
            className="ib"
            type="button"
            title={label}
            aria-label={label}
            onClick={() => setOpen(!open)}
          >
            <List />
          </button>
          {open && (
            <div className="pmenu rmenu ithreads" role="menu">
              {mine.map((c) => (
                <button
                  key={c.chatId}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    p.onOpenChat(c.chatId);
                  }}
                >
                  <span className="tt">{c.title}</span>
                  <span className="tm">{relTime(c.lastActivityAt)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </header>
  );
}
