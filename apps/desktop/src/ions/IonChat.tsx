import type { IonClient } from "@ion/client/browser";
import { ArrowUp, Check, ChevronDown, ChevronUp, CircleAlert, MessageSquare, Pin } from "@ion/design-system";
import type { ChatInfo, IonCard, IonEvent, IonInfo, NeedInfo } from "@ion/schema";
import { type KeyboardEvent, useEffect, useState } from "react";
import { IonAvatar } from "./IonAvatar.js";
import { IonHead } from "./IonHead.js";
import { type IonItem, ionTimeline } from "./ionTimeline.js";
import { Starting } from "../chats/ChatView.js";
import { Markdown } from "../chats/Message.js";
import type { Work } from "../chats/steps.js";
import { WorkBlock } from "../chats/Work.js";
import { SuggestionCard } from "./SuggestionCard.js";
import { ThreadLines, ThreadPeek } from "./ThreadLine.js";

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
  /** The thread open beside the chat, if any; `onPeek` opens one there. */
  peek: string | null;
  onPeek: (chatId: string) => void;
  /** A suggestion card's recorded answer, when you've given it. */
  answered?: boolean;
  muted?: true;
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
  if (p.card.kind === "threads")
    return (
      <ThreadLines
        client={p.client}
        threads={p.card.threads}
        chats={p.chats}
        ions={p.ions}
        peek={p.peek}
        onPeek={p.onPeek}
      />
    );
  if (p.card.kind === "suggest") return <Suggest {...p} card={p.card} />;
  if (p.card.kind === "routine" || p.card.kind === "stalled") return <SuggestionCard {...p} card={p.card} />;
  return (
    <div className="note">
      <CircleAlert />
      {`${p.card.failed} failed runs`}
    </div>
  );
}

const ownWords = (c?: IonCard) => c?.kind === "routine" || c?.kind === "stalled";
const ions = (m: IonItem | undefined) => m !== undefined && m.kind !== "you";

type LineProps = Omit<CardProps, "card"> & {
  m: Exclude<IonItem, { kind: "you" }>;
  work?: Work;
  last: boolean;
};

/** One of the ion's lines (its avatar on the last of a run): a turn's work above its words and card. */
function IonLine({ m, work, last, ...p }: LineProps) {
  const w = m.kind === "work" ? m.work : work;
  return (
    <div className="bm">
      {last ? <IonAvatar ion={p.ion} /> : <span />}
      <div>
        {w && <WorkBlock w={w} />}
        {/* ion chief's suggestion cards carry their own words. */}
        {m.kind === "ion" && m.text && !ownWords(m.card) && (
          <div className="bi">
            <Markdown text={m.text} htmlAsText />
          </div>
        )}
        {m.kind === "ion" && m.card && (
          <Card
            {...p}
            card={m.card}
            {...(m.answered !== undefined ? { answered: m.answered } : {})}
            {...(m.muted ? { muted: m.muted } : {})}
          />
        )}
      </div>
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
          const next = p.items[i + 1];
          // A turn's work shows above the reply that ends it; until then (live), on its own.
          if (m.kind === "work" && next?.kind === "ion") return null;
          const prev = p.items[i - 1];
          const work = m.kind === "ion" && prev?.kind === "work" ? prev.work : undefined;
          return <IonLine key={i} {...p} m={m} {...(work ? { work } : {})} last={!ions(next)} />;
        })}
        {/* Your message is the last thing: the ion is thinking (its reply takes this place). */}
        {p.items.at(-1)?.kind === "you" && (
          <div className="bm">
            <IonAvatar ion={p.ion} />
            <Starting />
          </div>
        )}
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

/**
 * An ion's chat, as the lab's `.ichat`: its header, the bubbles, the message box; a thread it started opens beside
 * it, like a chat's side panel.
 */
export function IonChat(p: Omit<CardProps, "card" | "peek" | "onPeek">) {
  const items = useIonChat(p.client, p.ion.ionId);
  const [peek, setPeek] = useState<string | null>(null);
  // The thread its panel shows when you open it from the header: the one you last looked at, else the latest.
  const [last, setLast] = useState<string | null>(null);
  const latest = latestThread(items);
  const open = peek ? p.chats.find((c) => c.chatId === peek) : undefined;
  const show = (chatId: string | null) => {
    setPeek(chatId);
    if (chatId) setLast(chatId);
  };
  const toggle = (chatId: string) => show(peek === chatId ? null : chatId);
  const again = last ?? latest;
  const panel = again ? { open: Boolean(open), toggle: () => show(open ? null : again) } : undefined;
  return (
    <section className={`ichat${open ? " peek" : ""}`}>
      <IonHead ion={p.ion} chats={p.chats} onOpenChat={p.onOpenChat} {...(panel ? { panel } : {})} />
      <Bubbles items={items} {...p} peek={open ? peek : null} onPeek={toggle} />
      <IonBox client={p.client} ion={p.ion} />
      {open && (
        <ThreadPeek
          key={open.chatId}
          client={p.client}
          chat={open}
          onClose={() => setPeek(null)}
          onOpenChat={p.onOpenChat}
        />
      )}
    </section>
  );
}

/** The last thread an ion's chat shows. */
function latestThread(items: IonItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    const c = it?.kind === "ion" ? it.card : undefined;
    if (c?.kind === "threads") return c.threads.at(-1)?.chatId ?? null;
  }
  return null;
}
