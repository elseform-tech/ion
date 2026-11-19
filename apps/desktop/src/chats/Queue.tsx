import type { IonClient } from "@ion/client/browser";
import { ArrowUp, Pencil, X } from "@ion/design-system";
import { type AskBrain, EV, type QueuedInfo, type QueueTarget } from "@ion/schema";
import { type Dispatch, type KeyboardEvent, type SetStateAction, useEffect, useRef, useState } from "react";
import { useCallError } from "../callError.js";
import { hit } from "../hotkeys.js";

/** Events after which a queue is read again (a question raised or answered: whether it waits for your answer). */
const CHANGES = new Set<string>([
  ...[EV.queueAdded, EV.queueRemoved, EV.queueSent, EV.queueFailed],
  ...[EV.needRaised, EV.needResolved],
]);

/** The events stream a queue's events land on: the chat's own, or the ion's chat. */
const streamOf = (to: QueueTarget) => ("chatId" in to ? to.chatId : `ion:${to.ionId}`);

/** What waits to go to a chat or an ion (none: a new chat), kept live from the daemon. */
function useQueued(client: IonClient, to: QueueTarget | null): QueuedInfo[] {
  const [items, setItems] = useState<QueuedInfo[]>([]);
  const stream = to ? streamOf(to) : null;
  const target = useRef(to);
  target.current = to;
  useEffect(() => {
    setItems([]);
    const t = target.current;
    if (!stream || !t) return;
    let gone = false;
    let stop: (() => void) | undefined;
    const quiet = () => {}; // a dropped connection shows as "ion isn't running"; nothing to add here
    const read = () => void client.call("queue.list", { to: t }).then((q) => !gone && setItems(q), quiet);
    void client
      .subscribe({ chatId: stream, fromNow: true }, (e) => {
        if (CHANGES.has(e.type)) read();
      })
      .then((s) => {
        if (gone) return s();
        stop = s;
        read();
      }, quiet);
    return () => {
      gone = true;
      stop?.();
    };
  }, [client, stream]);
  return items;
}

export type Queue = {
  items: QueuedInfo[];
  /** The daemon's last refusal (10 waiting, Already sent), until a call works again. */
  error: string | null;
  /** Queues it; `now`: and sends it now (the work stops). Resolves false when the daemon refused it. */
  add: (text: string, brain: AskBrain, now: boolean) => Promise<boolean>;
  sendNow: (queueId: string) => void;
  remove: (queueId: string) => void;
  /** Edit: its text, out of the queue (to put back in the box). */
  take: (queueId: string, then: (text: string) => void) => void;
  /** You changed the box: the last refusal goes. */
  clearError: () => void;
};

/** A chat's or an ion's queue, and what you can do with it. */
export function useQueue(client: IonClient, to: QueueTarget | null): Queue {
  const items = useQueued(client, to);
  const [error, run, clearError] = useCallError();
  const add = (text: string, brain: AskBrain, now: boolean) =>
    new Promise<boolean>((done) => {
      if (!to) return done(false);
      const queued = client.call("queue.add", { to, text, brain });
      queued.catch(() => done(false));
      run(queued, ({ queueId }) => {
        done(true);
        // The work may have ended meanwhile and sent it already: nothing more to do then.
        if (now) void client.call("queue.sendNow", { queueId }).catch(() => {});
      });
    });
  return {
    items,
    error,
    add,
    sendNow: (queueId) => run(client.call("queue.sendNow", { queueId })),
    remove: (queueId) => run(client.call("queue.remove", { queueId })),
    take: (queueId, then) => run(client.call("queue.take", { queueId }), (r) => then(r.text)),
    clearError,
  };
}

/**
 * What Enter does while the work goes: queue it, or (⌘Enter, Ctrl+Enter off macOS) send it now; null: not Enter,
 * or Enter picking a word in an input method.
 */
function enterKey(e: KeyboardEvent<HTMLTextAreaElement>): "queue" | "now" | null {
  if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return null;
  if (hit("now", e)) return "now";
  return hit("queue", e) ? "queue" : null;
}

type Box = {
  q: Queue;
  /** The chat's agent (or the ion) is working. */
  working: boolean;
  text: string;
  setText: (text: string) => void;
  /** Sends as when nothing works. */
  send: () => void;
  /** The brain to queue it with; null: it can't go (no text, no ready agent, a locked box). */
  brain: () => AskBrain | null;
};

/**
 * Sends when nothing works; while the work goes, queues it (`now`: and sends it now). Your words leave the box at
 * once and come back if the daemon says no.
 */
export function submit(b: Box, now: boolean): void {
  if (!b.working) return b.send();
  const brain = b.brain();
  const text = b.text;
  if (!brain || !text.trim()) return;
  b.setText("");
  void b.q.add(text.trim(), brain, now).then((ok) => !ok && b.setText(text));
}

/** The message box's Enter (Shift+Enter is a new line): see submit; ⌘Enter sends now. */
export const onEnter = (b: Box) => (e: KeyboardEvent<HTMLTextAreaElement>) => {
  const key = enterKey(e);
  if (!key) return;
  e.preventDefault();
  submit(b, key === "now");
};

/** Edit: the taken text goes back in the box (see putBack), and you go on typing at its end. */
export function useEditInto(setText: Dispatch<SetStateAction<string>>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [edits, setEdits] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!edits || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [edits]);
  const onEdit = (text: string) => {
    setText((box) => putBack(box, text));
    setEdits((n) => n + 1);
  };
  return { ref, onEdit };
}

/** The taken text back in the box: alone when it's empty, else after what's there. */
const putBack = (box: string, text: string) => (box.trim() ? `${box}\n${text}` : text);

/** Why it waits, when it does: its send failed, or it goes after your answer. */
function Why({ q }: { q: QueuedInfo }) {
  if (q.why) return <span className="why">{q.why}</span>;
  if (q.held) return <span className="why">After your answer</span>;
  return null;
}

/** The lab's queue: one line per waiting message, oldest first, right above the message box. */
export function QueueLines({ q, onEdit }: { q: Queue; onEdit: (text: string) => void }) {
  if (!q.items.length) return null;
  return (
    <div className="queue" role="list" aria-label="Queued">
      {q.items.map((m) => (
        <div className="qline" role="listitem" key={m.queueId}>
          <span className="t" title={m.text}>
            {m.text}
          </span>
          <Why q={m} />
          <button
            className="ib"
            type="button"
            title="Send now"
            aria-label="Send now"
            onClick={() => q.sendNow(m.queueId)}
          >
            <ArrowUp />
          </button>
          <button
            className="ib"
            type="button"
            title="Edit"
            aria-label="Edit"
            onClick={() => q.take(m.queueId, onEdit)}
          >
            <Pencil />
          </button>
          <button
            className="ib"
            type="button"
            title="Remove"
            aria-label="Remove"
            onClick={() => q.remove(m.queueId)}
          >
            <X />
          </button>
        </div>
      ))}
    </div>
  );
}

/** How close two presses of Esc must be to stop the work. */
const DOUBLE_ESC_MS = 500;

/** Esc twice, quickly, stops the work going (`going`: its id, or null when none); one Esc only closes what's open. */
export function useDoubleEsc(going: string | null, stop: (going: string) => void): void {
  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => {
    if (!going) return;
    let last = 0;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!hit("stop", e)) return;
      const now = Date.now();
      if (now - last < DOUBLE_ESC_MS) {
        last = 0;
        stopRef.current(going);
      } else last = now;
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [going]);
}
