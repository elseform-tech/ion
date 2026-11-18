import { Spinner, SquarePen } from "@ion/design-system";
import type { ChatInfo } from "@ion/schema";
import type { ReactNode } from "react";
import type { Groups } from "./live.js";

type Props = { groups: Groups; open: string | null; onOpen: (chatId: string | null) => void };

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="side-section">
      <h2>
        {title}
        {count !== undefined && <span>{count}</span>}
      </h2>
      {children}
    </section>
  );
}

function Row({
  chat,
  open,
  onOpen,
  title,
  end,
}: {
  chat: ChatInfo;
  open: boolean;
  onOpen: () => void;
  title?: string;
  end?: ReactNode;
}) {
  return (
    <button type="button" className={`row${open ? " row--open" : ""}`} onClick={onOpen}>
      <span className="row-text">
        <span className="row-title">{title ?? chat.title}</span>
        {title && <span className="row-sub">{chat.projectId}</span>}
      </span>
      {end}
    </button>
  );
}

/** Chats by what needs attention: Needs you, then Running (with a spinner), then everything else. */
export function Sidebar({ groups, open, onOpen }: Props) {
  return (
    <>
      <header className="side-head">
        <span>All projects</span>
        <button type="button" className="icon-button" aria-label="New chat" onClick={() => onOpen(null)}>
          <SquarePen size={16} />
        </button>
      </header>
      {groups.needsYou.length > 0 && (
        <Section title="Needs you" count={groups.needsYou.length}>
          {groups.needsYou.map(({ chat, need }) => (
            <Row
              key={need.needId}
              chat={chat}
              title={need.summary}
              open={open === chat.chatId}
              onOpen={() => onOpen(chat.chatId)}
              end={<span className="dot dot--wait" aria-label="Waiting on you" />}
            />
          ))}
        </Section>
      )}
      {groups.running.length > 0 && (
        <Section title="Running" count={groups.running.length}>
          {groups.running.map((c) => (
            <Row
              key={c.chatId}
              chat={c}
              open={open === c.chatId}
              onOpen={() => onOpen(c.chatId)}
              end={<Spinner />}
            />
          ))}
        </Section>
      )}
      <Section title="Chats">
        {groups.chats.map((c) => (
          <Row key={c.chatId} chat={c} open={open === c.chatId} onOpen={() => onOpen(c.chatId)} />
        ))}
      </Section>
    </>
  );
}
