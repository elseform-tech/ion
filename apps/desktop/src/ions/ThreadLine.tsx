import type { IonClient } from "@ion/client/browser";
import { ChevronRight, CircleAlert, Maximize2, X } from "@ion/design-system";
import type { ChatInfo, IonInfo } from "@ion/schema";
import { ChatView, useTimeline } from "../chats/ChatView.js";
import { useEstimate } from "../chats/estimate.js";
import { QuestionBar } from "../chats/QuestionBar.js";
import { Resizer } from "../chats/Resizer.js";
import { workSeconds } from "../chats/steps.js";
import type { Item, Timeline } from "../chats/timeline.js";
import { current, duration, useNow } from "../chats/Work.js";
import { useState } from "react";
import { IonAvatar } from "./IonAvatar.js";
import { projectName } from "../projectName.js";

type Work = Extract<Item, { kind: "work" }>;
type Question = Extract<Item, { kind: "question" }>;

const lastWork = (t: Timeline) => t.items.findLast((i): i is Work => i.kind === "work");
const openQuestion = (t: Timeline) =>
  t.items.findLast((i): i is Question => i.kind === "question" && !i.resolved);
const busy = (t: Timeline, c?: ChatInfo) =>
  Boolean(t.running) || ["queued", "running"].includes(c?.lastRunStatus ?? "");

/** What a thread is at, in a few words, and the time it's taken (so far, while it runs). */
function useThread(client: IonClient, chatId: string, c?: ChatInfo) {
  const t = useTimeline(client, chatId);
  const w = lastWork(t);
  const live = busy(t, c);
  const now = useNow(live);
  const waiting = Boolean(openQuestion(t));
  const secs = w ? workSeconds(w, now) : 0;
  let say = c?.title ?? "A chat";
  if (waiting) say = "Waiting for you";
  else if (live) say = w?.steps.length ? current(w) : (t.waiting ?? "Delegating");
  // Waiting for its agent's reset: it says so, and isn't failed (it goes on by itself).
  else if (c?.waiting) say = c.waiting;
  const failed = c?.lastRunStatus === "failed" && !c.waiting;
  return { say, live: live && !waiting, waiting, failed, secs, why: t.routed };
}

type LineProps = {
  client: IonClient;
  chatId: string;
  projectId: string;
  chat?: ChatInfo;
  ion?: IonInfo;
  /** Its thread is open beside the chat. */
  on: boolean;
  onOpen: () => void;
};

/**
 * One thread an ion started, as a line like a tool call's: its project's ion, what it's doing now (shimmering) and
 * for how long; once done, its title and how long it took. Opens the thread beside the chat.
 */
export function ThreadLine(p: LineProps) {
  const s = useThread(p.client, p.chatId, p.chat);
  // What such a task usually takes: asked on the first hover, and only while the thread is at work.
  const [hovered, setHovered] = useState(false);
  const atWork = s.live || s.waiting;
  const estimate = useEstimate(p.client, hovered && atWork ? { chatId: p.chatId } : null);
  return (
    <button
      className={`tl${p.on ? " on" : ""}`}
      type="button"
      aria-pressed={p.on}
      onClick={p.onOpen}
      onMouseEnter={() => setHovered(true)}
      // Why Pick by usage put the thread on its agent (the user, 2026-11-22) and what such a task usually takes, on
      // hover.
      title={[s.why, atWork ? estimate : null].filter(Boolean).join("\n") || undefined}
    >
      {p.ion ? <IonAvatar ion={p.ion} /> : null}
      <b>{projectName(p.projectId)}</b>
      {s.failed && !s.live ? <CircleAlert /> : null}
      <span className={`tt${s.live ? " now" : ""}`}>{s.say}</span>
      {s.waiting && <i className="wd" />}
      {s.secs >= 1 && !s.waiting && <span className="wn">· {duration(s.secs)}</span>}
      <ChevronRight />
    </button>
  );
}

/** The threads an ion started, one line each. */
export function ThreadLines(p: {
  client: IonClient;
  threads: { chatId: string; projectId: string }[];
  chats: ChatInfo[];
  ions: IonInfo[];
  peek: string | null;
  onPeek: (chatId: string) => void;
}) {
  return (
    <div className="tls">
      {p.threads.map((t) => (
        <ThreadLine
          key={t.chatId}
          client={p.client}
          chatId={t.chatId}
          projectId={t.projectId}
          chat={p.chats.find((c) => c.chatId === t.chatId)}
          ion={p.ions.find((i) => i.ionId === t.projectId)}
          on={p.peek === t.chatId}
          onOpen={() => p.onPeek(t.chatId)}
        />
      ))}
    </div>
  );
}

/** A thread open beside its ion's chat, like the chat's side panel: what it did, and its question if it asks one. */
export function ThreadPeek(p: {
  client: IonClient;
  chat: ChatInfo;
  onClose: () => void;
  onOpenChat: (chatId: string) => void;
}) {
  const t = useTimeline(p.client, p.chat.chatId);
  const q = openQuestion(t);
  return (
    <aside className="tpeek" aria-label={p.chat.title}>
      <Resizer name="--peek-w" label="Panel width" initial={420} min={320} max={760} edge="left" />
      <header className="head">
        <span className="title">{p.chat.title}</span>
        <span className="muted">{p.chat.projectId && projectName(p.chat.projectId)}</span>
        <span className="sp" />
        <button
          className="ib"
          type="button"
          aria-label="Open in Chats"
          title="Open in Chats"
          onClick={() => p.onOpenChat(p.chat.chatId)}
        >
          <Maximize2 />
        </button>
        <button className="ib" type="button" aria-label="Close" title="Close" onClick={p.onClose}>
          <X />
        </button>
      </header>
      <ChatView timeline={t} />
      {q && (
        <div className="foot">
          <div className="fcol">
            <QuestionBar key={q.needId} client={p.client} question={q} />
          </div>
        </div>
      )}
    </aside>
  );
}
