import type { IonClient } from "@ion/client/browser";
import { CircleAlert, Info, type LucideIcon, RotateCw, ShieldX, Square } from "@ion/design-system";
import type { IonEvent } from "@ion/schema";
import {
  type CSSProperties,
  memo,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { Markdown } from "./Message.js";
import { empty, type FileChange, type Item, reduce, type Timeline } from "./timeline.js";
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
  return (
    <div className="quiet">
      <RotateCw />
      Retrying in {left}s
    </div>
  );
}

/** A quiet line: an icon and one muted line in the conversation, never a banner. */
const Quiet = ({ text, icon: Icon }: { text: string; icon: LucideIcon }) => (
  <div className="quiet">
    <Icon />
    {text}
  </div>
);

/** How a run that didn't finish shows: a failed one says why (its last error) when it knows. */
function stopLine(item: Extract<Item, { kind: "end" }>): ReactNode {
  if (item.status === "failed") return <Quiet text={item.reason ?? "Failed"} icon={CircleAlert} />;
  if (item.status === "interrupted" || item.status === "capped")
    return <Quiet text="Stopped" icon={Square} />;
  return null;
}

function show(item: Item, onFile?: (path: string) => void): ReactNode {
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
      return <Quiet text={item.text} icon={item.tone === "deny" ? ShieldX : Info} />;
    case "question":
      return null; // open ones are in the bar above the message box; answers go into the chat as messages
    case "end":
      return (
        <>
          {item.files && <Files files={item.files} onFile={onFile} />}
          {stopLine(item)}
        </>
      );
    case "retry":
      return <Retry until={item.until} done={item.done} />;
    case "error":
      return item.gone ? null : <Quiet text={item.text} icon={CircleAlert} />;
  }
}

/** What the chat says while a run starts: a playful word every 3 s, shimmering, stronger as the wait grows. */
const WORDS = ["Thinking", "Cooking", "Brewing", "Pondering", "Tinkering", "Noodling"];
const WORD_MS = 3000;
const FULL_MS = 20_000;

export function Starting() {
  const [from] = useState(() => Date.now());
  const [now, setNow] = useState(from);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const waited = now - from;
  const strength = Math.min(1, 0.2 + (0.8 * waited) / FULL_MS);
  return (
    <div className="quiet pending now" style={{ "--strength": strength.toFixed(2) } as CSSProperties}>
      {WORDS[Math.floor(waited / WORD_MS) % WORDS.length]}
    </div>
  );
}

/** A run's changed files: how many, then each with its counts; a file opens the panel at it. */
function Files({ files, onFile }: { files: FileChange[]; onFile?: (path: string) => void }) {
  return (
    <div className="files">
      <div className="fsum">
        {files.length} {files.length === 1 ? "file" : "files"} changed
      </div>
      {files.map((f) => (
        <button type="button" key={f.path} onClick={() => onFile?.(f.path)}>
          <span className="fp">{f.path}</span>
          {f.added > 0 && <span className="plus">+{f.added}</span>}
          {f.removed > 0 && <span className="minus">−{f.removed}</span>}
        </button>
      ))}
    </div>
  );
}

/** One item. Unchanged items keep their identity, so a new event re-renders only what changed. */
const Row = memo(function Row({ item, onFile }: { item: Item; onFile?: (path: string) => void }) {
  return <>{show(item, onFile)}</>;
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
/** `onFile`: a changed file was picked (open the panel at it). */
export function ChatView({ timeline, onFile }: { timeline: Timeline; onFile?: (path: string) => void }) {
  const last = timeline.items.at(-1);
  // Follow new items, and a streaming message as it grows.
  const follow = useFollow(timeline.items.length * 1e6 + (last?.kind === "agent" ? last.text.length : 0));
  return (
    <div className="msgs" role="log" aria-live="polite" ref={follow.ref} onScroll={follow.onScroll}>
      <div className="col">
        {timeline.items.map((item, i) => (
          <Row key={i} item={item} onFile={onFile} />
        ))}
        {timeline.running && last?.kind === "you" && <Starting />}
      </div>
    </div>
  );
}
