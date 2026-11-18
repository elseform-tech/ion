import type { IonClient } from "@ion/client/browser";
import { ChevronDown, ChevronRight, Wrench } from "@ion/design-system";
import type { IonEvent } from "@ion/schema";
import { memo, type ReactNode, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { Markdown } from "./Message.js";
import { empty, type Item, reduce, type Timeline, type Tool } from "./timeline.js";

/** "2m 04s", "45s". */
function duration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

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
      .then((s) => {
        if (gone) s();
        else stop = s;
      });
    return () => {
      gone = true;
      stop?.();
    };
  }, [client, chatId]);
  return t;
}

/** One tool call: its name and summary; open it to see exactly what went in and what came out. */
function ToolCall({ tool }: { tool: Tool }) {
  return (
    <details className={`tool${tool.ok === false ? " bad" : ""}`}>
      <summary>
        <span className="tool-name">{tool.name}</span> {tool.summary}
      </summary>
      {tool.input && (
        <>
          <div className="tool-io-label">Input</div>
          <pre className="tool-io">{tool.input}</pre>
        </>
      )}
      {tool.output && (
        <>
          <div className="tool-io-label">Output</div>
          <pre className="tool-io">{tool.output}</pre>
        </>
      )}
      {!tool.input && !tool.output && <div className="tool-io-label">Nothing more to show</div>}
    </details>
  );
}

function Work({ tools }: { tools: Tool[] }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="work">
      <button type="button" className="work-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Chevron size={14} />
        <Wrench size={14} />
        Used {tools.length} {tools.length === 1 ? "tool" : "tools"}
      </button>
      {open && (
        <div className="work-tools">
          {tools.map((x, i) => (
            <ToolCall key={i} tool={x} />
          ))}
        </div>
      )}
    </div>
  );
}

const ENDS: Record<string, string> = {
  done: "Done",
  failed: "Failed",
  interrupted: "Stopped",
  capped: "Stopped",
};

function End({ item }: { item: Extract<Item, { kind: "end" }> }) {
  const cost = item.cost !== undefined ? ` · $${item.cost.toFixed(4)}` : "";
  return (
    <div className="line line--end">{`${ENDS[item.status] ?? item.status} · ${duration(item.seconds)}${cost}`}</div>
  );
}

function show(item: Item): ReactNode {
  switch (item.kind) {
    case "you":
      return <div className="you">{item.text}</div>;
    case "agent":
      return <Markdown text={item.text} />;
    case "work":
      return <Work tools={item.tools} />;
    case "ion":
      return <div className={`line line--${item.tone}`}>· {item.text}</div>;
    case "question":
      return (
        <div className="asked">
          <div className="asked-q">{item.question}</div>
          {item.answered && <div className="line line--answer">· You chose: {item.answered}</div>}
        </div>
      );
    case "end":
      return <End item={item} />;
    case "error":
      return <div className="line line--deny">{item.text}</div>;
  }
}

/** One item. Unchanged items keep their identity, so a new event re-renders only what changed. */
const Row = memo(function Row({ item }: { item: Item }) {
  return <div className={`item item--${item.kind}`}>{show(item)}</div>;
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

/** The open chat: what you asked, what the agent did and said, and what ion decided. */
export function ChatView({ timeline }: { timeline: Timeline }) {
  const last = timeline.items.at(-1);
  // Follow new items, and a streaming message as it grows.
  const follow = useFollow(timeline.items.length * 1e6 + (last?.kind === "agent" ? last.text.length : 0));
  return (
    <div className="timeline" role="log" aria-live="polite" ref={follow.ref} onScroll={follow.onScroll}>
      {timeline.items.map((item, i) => (
        <Row key={i} item={item} />
      ))}
    </div>
  );
}
