import type { IonClient } from "@ion/client/browser";
import type { IonEvent } from "@ion/schema";
import { memo, type ReactNode, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { Markdown } from "./Message.js";
import { empty, type Item, reduce, type Timeline } from "./timeline.js";
import { WorkBlock } from "./Work.js";

const step = (t: Timeline, a: IonEvent | "reset"): Timeline => (a === "reset" ? empty() : reduce(t, a));

/** A chat's timeline, live: its backlog first, then each new event, from the daemon. */
export function useTimeline(client: IonClient, chatId: string): Timeline {
  const [t, dispatch] = useReducer(step, undefined, empty);
  useEffect(() => {
    dispatch("reset");
    let stop: (() => void) | undefined;
    let gone = false;
    // Only this chat's events, and none once it's closed (a late backlog from the old chat is dropped).
    void client
      .subscribe({ chatId }, (e) => {
        if (!gone && e.chatId === chatId) dispatch(e);
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
  }, [client, chatId]);
  return t;
}

/** "Retrying in 3s", counting down; nothing once the retry has started. */
function Retry({ until, done }: { until: string; done: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (done) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [done]);
  if (done) return null;
  const left = Math.max(0, Math.ceil((Date.parse(until) - now) / 1000));
  return <div className="quiet">Retrying in {left}s</div>;
}

/** A quiet line: one muted line in the conversation (a block gets a small mark), never a banner. */
const Quiet = ({ text, mark }: { text: string; mark?: boolean }) => (
  <div className="quiet">
    {mark && <i className="qm" />}
    {text}
  </div>
);

const STOPS: Record<string, string> = { failed: "Failed", interrupted: "Stopped", capped: "Stopped" };

function show(item: Item): ReactNode {
  switch (item.kind) {
    case "you":
      return <div className="u">{item.text}</div>;
    case "agent":
      return (
        <div className="a">
          <Markdown text={item.text} />
        </div>
      );
    case "work":
      return <WorkBlock w={item} />;
    case "ion":
      return <Quiet text={item.text} mark={item.tone === "deny"} />;
    case "question":
      return null; // open ones are in the bar above the message box; answers go into the chat as messages
    case "end":
      return STOPS[item.status] ? <Quiet text={STOPS[item.status]!} /> : null;
    case "retry":
      return <Retry until={item.until} done={item.done} />;
    case "error":
      return <Quiet text={item.text} />;
  }
}

/** One item. Unchanged items keep their identity, so a new event re-renders only what changed. */
const Row = memo(function Row({ item }: { item: Item }) {
  return <>{show(item)}</>;
});

/** Keeps the newest at the bottom in view, unless you've scrolled up to read. */
function useFollow(count: number) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [count]);
  const onScroll = () => {
    const el = ref.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  return { ref, onScroll };
}

/** The conversation, as the lab's `.msgs > .col`: your messages, the agent's work and replies, quiet notes. */
export function ChatView({ timeline }: { timeline: Timeline }) {
  const last = timeline.items.at(-1);
  // Follow new items, and a streaming message as it grows.
  const follow = useFollow(timeline.items.length * 1e6 + (last?.kind === "agent" ? last.text.length : 0));
  return (
    <div className="msgs" role="log" aria-live="polite" ref={follow.ref} onScroll={follow.onScroll}>
      <div className="col">
        {timeline.items.map((item, i) => (
          <Row key={i} item={item} />
        ))}
      </div>
    </div>
  );
}
