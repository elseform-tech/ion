import type { IonClient } from "@ion/client/browser";
import {
  Avatar,
  BellOff,
  CalendarClock,
  Check,
  CircleCheck,
  CircleAlert,
  FileDiff,
  Folder,
  Hourglass,
  MessageSquare,
  Repeat,
} from "@ion/design-system";
import { type ChatInfo, type IonCard, type IonInfo, whenLabel } from "@ion/schema";
import { type ReactNode, useState } from "react";

type Chief = Extract<IonCard, { kind: "routine" | "stalled" | "todo" }>;
/** Your answer: taken, not now, or not now and fewer like this. */
type Answer = "took" | "later" | "muted";

export type SuggestionProps = {
  card: Chief;
  chats: ChatInfo[];
  ions: IonInfo[];
  client: IonClient;
  onOpenChat: (chatId: string) => void;
  /** Your answer, once you've given it (from the chat's events). */
  answered?: boolean;
  muted?: true;
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Fri 7 Nov", as the lab writes a day. */
const dayLabel = (iso: string) => {
  const d = new Date(iso);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
};
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** What the card asks, as the ion says it. */
const askOf = (c: Chief) => {
  if (c.kind === "todo") return `Mark “${c.name}” done?`;
  return c.kind === "routine" ? `Make “${c.name}” a routine?` : `Resume “${c.title}”?`;
};

/** The card's icon: a routine, a stalled chat, a to-do. */
const iconOf = (c: Chief) => {
  if (c.kind === "todo") return <CircleCheck className="si" />;
  return c.kind === "routine" ? <Repeat className="si" /> : <Hourglass className="si" />;
};

/** The project, with its ion's avatar (a project without an ion, `default`, gets a folder). */
function Project({ id, ions }: { id: string; ions: IonInfo[] }) {
  const ion = ions.find((x) => x.ionId === id);
  return (
    <span>
      {ion ? <Avatar ion={{ harness: ion.harness, color: ion.color }} /> : <Folder />}
      {id}
    </span>
  );
}

/** The evidence: the days you asked; how long it's stalled and what it changed; the chat that did the to-do. */
function Evidence({ card, chats, onOpenChat }: Pick<SuggestionProps, "card" | "chats" | "onOpenChat">) {
  if (card.kind === "todo") {
    const title = chats.find((c) => c.chatId === card.chatId)?.title ?? "Chat";
    return (
      <button type="button" onClick={() => onOpenChat(card.chatId)}>
        <MessageSquare />
        {title}
      </button>
    );
  }
  if (card.kind === "routine")
    return (
      <>
        {card.dates.map((d) => (
          <span key={d}>
            <MessageSquare />
            {dayLabel(d)}
          </span>
        ))}
      </>
    );
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(card.since)) / 86_400_000));
  const chip = (icon: ReactNode, text: string) => (
    <button type="button" onClick={() => onOpenChat(card.chatId)}>
      {icon}
      {text}
    </button>
  );
  return (
    <>
      {chip(<Hourglass />, `Stalled ${plural(days, "day")}`)}
      {chip(<FileDiff />, plural(card.files, "file"))}
    </>
  );
}

/** What taking it did: the routine's time, "Resumed", or "Done". */
function tookLabel(c: Chief): string {
  if (c.kind === "routine") return whenLabel(c.when);
  return c.kind === "todo" ? "Done" : "Resumed";
}

/** What came of it: the routine's time or "Resumed"; "Not now"; "Fewer like this"; or the chat moved on without it. */
function Done({ card, answer }: { card: Chief; answer: Answer | "moved" }) {
  if (answer === "moved") return <div className="done">Picked up</div>;
  const later = card.kind === "todo" ? "Not yet" : "Not now";
  const label = { took: tookLabel(card), later, muted: "Fewer like this" }[answer];
  return (
    <div className="done">
      {answer === "took" ? <Check /> : <BellOff />}
      {label}
    </div>
  );
}

const answerOf = (p: SuggestionProps): Answer | null => {
  if (p.answered === undefined) return null;
  if (p.answered) return "took";
  return p.muted ? "muted" : "later";
};

const TAKE = { routine: "Add routine", stalled: "Resume", todo: "Done" } as const;

/** Add routine (or Resume), Not now, and fewer like this; a to-do's Done and Not yet. */
function Acts({ card, send }: { card: Chief; send: (a: Answer) => void }) {
  return (
    <div className="acts">
      <button className="btn pri" type="button" onClick={() => send("took")}>
        {TAKE[card.kind]}
      </button>
      <button className="mute" type="button" onClick={() => send("later")}>
        {card.kind === "todo" ? "Not yet" : "Not now"}
      </button>
      {card.kind !== "todo" && (
        <button
          className="ib"
          type="button"
          title="Fewer like this"
          aria-label="Fewer like this"
          onClick={() => send("muted")}
        >
          <BellOff />
        </button>
      )}
    </div>
  );
}

/**
 * One of ion chief's suggestions, as the lab's slim `.sugg` card: what it asks with Add routine (or Resume) / Not now
 * / fewer like this beside it (once answered, what came of it); under it, its evidence, when and where.
 */
export function SuggestionCard(p: SuggestionProps) {
  const { card } = p;
  const [answer, setAnswer] = useState<Answer | null>(answerOf(p));
  const [error, setError] = useState<string | null>(null);
  // A stalled chat you went back to yourself: nothing left to resume.
  const moved =
    card.kind === "stalled" &&
    p.chats.some((c) => c.chatId === card.chatId && c.lastActivityAt !== card.since);
  const send = (a: Answer) => {
    const args = {
      suggestionId: card.suggestionId,
      keep: a === "took",
      ...(a === "muted" ? { mute: true } : {}),
    };
    void p.client.call("suggestion.answer", args).then(
      () => setAnswer(a),
      (e: unknown) => setError(e instanceof Error ? e.message : "Something went wrong"),
    );
  };
  const shown = answer ?? (moved ? "moved" : null);
  return (
    <div className="sugg">
      <div className="sh">
        <b>
          {iconOf(card)}
          <span className="st" title={askOf(card)}>
            {askOf(card)}
          </span>
        </b>
        {shown ? <Done card={card} answer={shown} /> : <Acts card={card} send={send} />}
      </div>
      <div className="sm2">
        <Evidence card={card} chats={p.chats} onOpenChat={p.onOpenChat} />
        {card.kind === "routine" && shown !== "took" && (
          <span>
            <CalendarClock />
            {whenLabel(card.when)}
          </span>
        )}
        <Project id={card.projectId} ions={p.ions} />
      </div>
      {error && !shown && (
        <div className="sk">
          <CircleAlert />
          {error}
        </div>
      )}
    </div>
  );
}
