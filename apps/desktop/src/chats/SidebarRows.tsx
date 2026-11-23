import { Archive, Avatar, CircleAlert, Ellipsis, NotebookText, Pencil, Square } from "@ion/design-system";
import type { ChatInfo, IonInfo, NeedInfo } from "@ion/schema";
import { type KeyboardEvent, useRef, useState } from "react";
import { useDismiss } from "./dismiss.js";
import { relTime } from "./live.js";

/** `ion`: the chat's project ion, when ion started the chat (its avatar fills the first slot). */
export type RowProps = { chat: ChatInfo; open: boolean; onOpen: () => void; ion?: IonInfo };

/** The first slot: the project's ion for a thread ion started; empty for your own chats. */
const Slot = ({ ion }: { ion?: IonInfo }) =>
  ion ? <Avatar ion={{ harness: ion.harness, color: ion.color }} /> : <span />;
export type RowActions = {
  onRename: (chatId: string, title: string) => void;
  onArchive: (chatId: string) => void;
  /** Remember (true) or Don't remember (false) the chat. */
  onRemember: (chatId: string, on: boolean) => void;
};

/** A Needs-you row: the question, its project under it, the wait dot. */
export const NeedRow = ({ chat, open, onOpen, need, ion }: RowProps & { need: NeedInfo }) => (
  <button className={`r${open ? " on" : ""}`} type="button" onClick={onOpen}>
    <Slot ion={ion} />
    <span>
      <span className="tt">{need.summary}</span>
      <span className="sub">{chat.projectId}</span>
    </span>
    <i className="wd" />
  </button>
);

/** How a chat's last run ended, when that's worth a mark: failed or stopped. */
const MARKS: Record<string, { label: string; Icon: typeof CircleAlert }> = {
  failed: { label: "Failed", Icon: CircleAlert },
  interrupted: { label: "Stopped", Icon: Square },
  capped: { label: "Stopped", Icon: Square },
};

/** When it was last active, after a mark if its last run failed or was stopped. */
function When({ chat }: { chat: ChatInfo }) {
  // A chat waiting (for its agent's reset) isn't marked failed: it goes on by itself.
  const mark = chat.waiting ? undefined : MARKS[chat.lastRunStatus ?? ""];
  return (
    <span className="tm">
      {mark && <mark.Icon className="st" aria-label={mark.label} />}
      {relTime(chat.lastActivityAt)}
    </span>
  );
}

/** The chat's name in an input, saved on Enter or when you leave it; Escape leaves it as it was. */
function RenameBox({ chat, onDone }: { chat: ChatInfo; onDone: (title: string | null) => void }) {
  const [title, setTitle] = useState(chat.title);
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") onDone(title);
    if (e.key === "Escape") onDone(null);
  };
  return (
    <div className="r on rename">
      <span />
      {/* biome-ignore lint/a11y/noAutofocus: renaming starts in the box you asked for */}
      <input
        aria-label="Chat name"
        value={title}
        autoFocus
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => onDone(title)}
      />
    </div>
  );
}

/** The row's menu: Rename, Don't remember (or Remember) and Archive. */
function RowMenu({ chat, acts, onRename }: { chat: ChatInfo; acts: RowActions; onRename: () => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useDismiss(open, wrap, () => setOpen(false));
  const pick = (f: () => void) => () => {
    setOpen(false);
    f();
  };
  return (
    <div className="rmore" ref={wrap}>
      <button
        className="ib"
        type="button"
        aria-label={`More for ${chat.title}`}
        onClick={() => setOpen(!open)}
      >
        <Ellipsis />
      </button>
      {open && (
        <div className="pmenu rmenu" role="menu">
          <button type="button" role="menuitem" onClick={pick(onRename)}>
            <Pencil />
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={pick(() => acts.onRemember(chat.chatId, !!chat.notRemembered))}
          >
            <NotebookText />
            {chat.notRemembered ? "Remember" : "Don't remember"}
          </button>
          <button type="button" role="menuitem" onClick={pick(() => acts.onArchive(chat.chatId))}>
            <Archive />
            Archive
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * A chat row: its title (shimmering while it runs) with the start of the agent's last reply (or why it waits for a
 * slot) under it, then when
 * it was last active, and its menu on hover. The first slot stays empty: an avatar there marks a thread ion
 * started, not yours.
 */
export function ChatRow({
  chat,
  open,
  onOpen,
  running,
  acts,
  ion,
}: RowProps & { running?: boolean; acts: RowActions }) {
  const [renaming, setRenaming] = useState(false);
  // A chat ion started, waiting for one of its slots, says why (the lab's queued row).
  const sub = chat.waiting ?? chat.preview;
  if (renaming)
    return (
      <RenameBox
        chat={chat}
        onDone={(title) => {
          setRenaming(false);
          if (title?.trim() && title.trim() !== chat.title) acts.onRename(chat.chatId, title.trim());
        }}
      />
    );
  return (
    <div className="rw">
      <button className={`r${open ? " on" : ""}`} type="button" onClick={onOpen}>
        <Slot ion={ion} />
        <span>
          <span className={`tt${running ? " now" : ""}`}>{chat.title}</span>
          {sub && <span className="sub">{sub}</span>}
        </span>
        {!running && <When chat={chat} />}
      </button>
      <RowMenu chat={chat} acts={acts} onRename={() => setRenaming(true)} />
    </div>
  );
}
