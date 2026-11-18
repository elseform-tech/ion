import type { IonClient } from "@ion/client/browser";
import { ChevronDown, ChevronRight, Wrench } from "@ion/design-system";
import type { IonEvent } from "@ion/schema";
import { type ReactNode, useEffect, useReducer, useState } from "react";
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
        <ul className="work-tools">
          {tools.map((x, i) => (
            <li key={i} className={x.ok === false ? "bad" : ""}>
              <span className="tool-name">{x.name}</span> {x.summary}
            </li>
          ))}
        </ul>
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

/** The open chat: what you asked, what the agent did and said, and what ion decided. */
export function ChatView({ timeline }: { timeline: Timeline }) {
  return (
    <div className="timeline">
      {timeline.items.map((item, i) => (
        <div key={i} className={`item item--${item.kind}`}>
          {show(item)}
        </div>
      ))}
    </div>
  );
}
