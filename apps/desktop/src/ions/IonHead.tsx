import { List, PanelRight } from "@ion/design-system";
import type { ChatInfo, IonInfo } from "@ion/schema";
import { useRef, useState } from "react";
import { useDismiss } from "../chats/dismiss.js";
import { relTime } from "../chats/live.js";
import { IonAvatar, IonName } from "./IonAvatar.js";

/** The chats an ion started (ion chief: every ion's), newest first. */
const startedBy = (ion: IonInfo, chats: ChatInfo[]) =>
  chats.filter((c) => c.by === "ion" && !c.archived && (ion.ionId === "chief" || c.projectId === ion.ionId));

/** The chats an ion started, one click away (a list in a menu). */
function Started({
  ion,
  chats,
  onOpenChat,
}: {
  ion: IonInfo;
  chats: ChatInfo[];
  onOpenChat: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useDismiss(open, wrap, () => setOpen(false));
  const mine = startedBy(ion, chats);
  const label = `Chats started by ${ion.name}`;
  if (!mine.length) return null;
  return (
    <div className="pwrap" ref={wrap}>
      <button className="ib" type="button" title={label} aria-label={label} onClick={() => setOpen(!open)}>
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
                onOpenChat(c.chatId);
              }}
            >
              <span className="tt">{c.title}</span>
              <span className="tm">{relTime(c.lastActivityAt)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Shows or hides the threads' panel beside the chat, like a chat's side panel. */
function PanelToggle({ open, toggle }: { open: boolean; toggle: () => void }) {
  const label = open ? "Hide thread" : "Show thread";
  return (
    <button
      type="button"
      className={`ib${open ? " on" : ""}`}
      aria-label={label}
      title={label}
      aria-pressed={open}
      onClick={toggle}
    >
      <PanelRight />
    </button>
  );
}

/** The lab's ion header: its avatar and name, the chats it started, and its threads' panel. */
export function IonHead(p: {
  ion: IonInfo;
  chats: ChatInfo[];
  onOpenChat: (chatId: string) => void;
  /** Shows or hides its threads' panel; absent while it has started none. */
  panel?: { open: boolean; toggle: () => void };
}) {
  return (
    <header className="head" data-tauri-drag-region>
      <IonAvatar ion={p.ion} />
      <IonName ion={p.ion} className="title" />
      <span className="sp" />
      <Started ion={p.ion} chats={p.chats} onOpenChat={p.onOpenChat} />
      {p.panel && <PanelToggle {...p.panel} />}
    </header>
  );
}
