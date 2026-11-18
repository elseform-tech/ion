import type { IonClient } from "@ion/client/browser";
import {
  ArrowUp,
  Avatar,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  MessageSquare,
  Pin,
  Split,
} from "@ion/design-system";
import type { ChatInfo, IonCard, IonEvent, IonInfo, NeedInfo } from "@ion/schema";
import { type KeyboardEvent, useEffect, useState } from "react";
import { type IonItem, ionTimeline } from "./ionTimeline.js";

/** An ion's avatar: ion chief's orbit bot, or its project's colour on its agent's shape. */
export const IonAvatar = ({ ion }: { ion: IonInfo }) => (
  <Avatar ion={ion.ionId === "chief" ? "chief" : { harness: ion.harness, color: ion.color }} />
);

/** ion chief's name is the wordmark. */
export const IonName = ({ ion, className }: { ion: IonInfo; className: string }) =>
  ion.ionId === "chief" ? (
    <span className={`brand ${className}`} aria-label="ion">
      i<i>o</i>n
    </span>
  ) : (
    <span className={className}>{ion.name}</span>
  );

/** An ion's chat, live: its backlog, then each new line. */
function useIonChat(client: IonClient, ionId: string): IonItem[] {
  const [events, setEvents] = useState<IonEvent[]>([]);
  useEffect(() => {
    setEvents([]);
    let stop: (() => void) | undefined;
    let gone = false;
    void client
      .subscribe({ chatId: `ion:${ionId}` }, (e) => {
        if (!gone) setEvents((xs) => [...xs, e]);
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
  }, [client, ionId]);
  return ionTimeline(events);
}

type CardProps = {
  card: IonCard;
  chats: ChatInfo[];
  needs: NeedInfo[];
  ion: IonInfo;
  /** Every ion, for the avatars on a fan-out card. */
  ions: IonInfo[];
  client: IonClient;
  onOpenChat: (chatId: string) => void;
  /** A suggestion card's recorded answer, when you've given it. */
  answered?: boolean;
};

/** What needs you, pinned atop ion chief's chat (the lab's): one quiet line until you open it. */
function Pins({ needs, onOpenChat }: { needs: NeedInfo[]; onOpenChat: (chatId: string) => void }) {
  const [open, setOpen] = useState(false);
  const first = needs[0];
  if (!first) return null;
  if (!open)
    return (
      <button className="pins mini" type="button" aria-expanded={false} onClick={() => setOpen(true)}>
        <Pin />
        <b>Needs you</b>
        <span className="ct">{needs.length}</span>
        <span className="sep" />
        <span className="peek">{first.summary}</span>
        <span className="sp" />
        <ChevronDown />
      </button>
    );
  return (
    <div className="pins">
      <div className="pinh">
        <Pin />
        <b>Needs you</b>
        <span className="ct">{needs.length}</span>
        <span className="sp" />
        <button className="ib" type="button" aria-label="Collapse" onClick={() => setOpen(false)}>
          <ChevronUp />
        </button>
      </div>
      {needs.map((n) => (
        <div className="pin" key={n.needId}>
          <MessageSquare />
          <span className="g">
            <b>{n.summary}</b>
            <small>{n.projectId}</small>
          </span>
          <span />
          <span />
          <button className="btn pri" type="button" onClick={() => onOpenChat(n.chatId)}>
            Open
          </button>
        </div>
      ))}
    </div>
  );
}

const running = (c?: ChatInfo) => ["queued", "running"].includes(c?.lastRunStatus ?? "");

/** One thread the ion started: its title (shimmering while it runs) and project; opens the chat. */
function ThreadLink({ c, projectId, onOpen }: { c?: ChatInfo; projectId: string; onOpen: () => void }) {
  return (
    <button className="tlink" type="button" onClick={onOpen}>
      <MessageSquare />
      <span className="g">
        <span className={running(c) ? "now" : undefined}>{c?.title ?? "A thread"}</span>
        <small>{projectId}</small>
      </span>
      <ChevronRight />
    </button>
  );
}

/**
 * The threads an ion started: one is a link; several (ion chief asking projects) are the lab's fan-out card, a row
 * per project's ion with its thread.
 */
function Threads({
  card,
  chats,
  ions,
  onOpenChat,
}: CardProps & { card: Extract<IonCard, { kind: "threads" }> }) {
  const chat = (id: string) => chats.find((x) => x.chatId === id);
  const [only] = card.threads;
  if (only && card.threads.length === 1)
    return (
      <ThreadLink c={chat(only.chatId)} projectId={only.projectId} onOpen={() => onOpenChat(only.chatId)} />
    );
  return (
    <div className="fan">
      <div className="fanh">
        <Split />
        {`Asked ${card.threads.length} projects`}
      </div>
      {card.threads.map((t) => {
        const ion = ions.find((x) => x.ionId === t.projectId);
        const c = chat(t.chatId);
        return (
          <button className="fanr" type="button" key={t.chatId} onClick={() => onOpenChat(t.chatId)}>
            {ion ? <IonAvatar ion={ion} /> : <span />}
            <b>{t.projectId}</b>
            <span className={`ft2${running(c) ? " now" : ""}`}>{c?.title ?? "A thread"}</span>
            <ChevronRight />
          </button>
        );
      })}
    </div>
  );
}

/** ion's "always?" suggestion: No or Keep; once answered, it says so. */
function Suggest({
  card,
  ion,
  client,
  answered,
}: CardProps & { card: Extract<IonCard, { kind: "suggest" }> }) {
  const [done, setDone] = useState<boolean | null>(answered ?? null);
  const [error, setError] = useState<string | null>(null);
  const answer = (keep: boolean) =>
    void client.call("suggestion.answer", { suggestionId: card.suggestionId, keep }).then(
      () => setDone(keep),
      (e: unknown) => setError(e instanceof Error ? e.message : "Something went wrong"),
    );
  if (error) return <div className="note">{error}</div>;
  return (
    <div className="ncard">
      <IonAvatar ion={ion} />
      <div>
        <b>{card.choice}</b>
        <div className="s">{card.question}</div>
      </div>
      {done === null ? (
        <div className="acts">
          <span className="sp" />
          <button className="btn" type="button" onClick={() => answer(false)}>
            No
          </button>
          <button className="btn pri" type="button" onClick={() => answer(true)}>
            Keep
          </button>
        </div>
      ) : (
        <div className="done">
          {done ? <Check /> : null}
          {done ? "Always, for this project" : "Not now"}
        </div>
      )}
    </div>
  );
}

function Card(p: CardProps) {
  if (p.card.kind === "threads") return <Threads {...p} card={p.card} />;
  if (p.card.kind === "suggest") return <Suggest {...p} card={p.card} />;
  return (
    <div className="note">
      <CircleAlert />
      {`${p.card.failed} failed runs`}
    </div>
  );
}

/** The bubbles: yours on the right; the ion's on the left, its avatar on the last of a run of its lines. */
function Bubbles(p: { items: IonItem[] } & Omit<CardProps, "card">) {
  return (
    <div className="bubbles">
      {p.ion.ionId === "chief" && <Pins needs={p.needs} onOpenChat={p.onOpenChat} />}
      <div className="bcol">
        {p.items.map((m, i) => {
          if (m.kind === "you")
            return (
              <div className="bu" key={i}>
                {m.text}
              </div>
            );
          const last = p.items[i + 1]?.kind !== "ion";
          return (
            <div className="bm" key={i}>
              {last ? <IonAvatar ion={p.ion} /> : <span />}
              <div>
                {m.text && <div className="bi">{m.text}</div>}
                {m.card && (
                  <Card
                    {...p}
                    card={m.card}
                    {...(m.answered !== undefined ? { answered: m.answered } : {})}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The message box for an ion: Enter sends. */
function IonBox({ client, ion }: { client: IonClient; ion: IonInfo }) {
  const [text, setText] = useState("");
  const send = () => {
    if (!text.trim()) return;
    void client.call("ion.message", { ionId: ion.ionId, text: text.trim() }).catch(() => {});
    setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    send();
  };
  return (
    <div className="foot">
      <div className="fcol">
        <div className="cbox">
          <textarea
            aria-label={`Message ${ion.name}`}
            placeholder={`Message ${ion.name}`}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
          />
          <div className="bar">
            <span className="sp" />
            <button type="button" className="send" aria-label="Send" disabled={!text.trim()} onClick={send}>
              <ArrowUp />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** An ion's chat, as the lab's `.ichat`: its header, the bubbles, the message box. */
export function IonChat(p: Omit<CardProps, "card">) {
  const items = useIonChat(p.client, p.ion.ionId);
  return (
    <section className="ichat">
      <header className="head" data-tauri-drag-region>
        <IonAvatar ion={p.ion} />
        <IonName ion={p.ion} className="title" />
      </header>
      <Bubbles items={items} {...p} />
      <IonBox client={p.client} ion={p.ion} />
    </section>
  );
}
