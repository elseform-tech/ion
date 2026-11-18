import { ApiCallError, type IonClient } from "@ion/client/browser";
import { ChevronUp } from "@ion/design-system";
import { type KeyboardEvent, useState } from "react";
import type { Item } from "./timeline.js";

type Question = Extract<Item, { kind: "question" }>;
type Pick = { choice: number } | { text: string };

/** Answers the question, showing ion's refusal (already answered, the run stopped…) in place. */
function useAnswer(client: IonClient, needId: string) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const answer = async (pick: Pick, always: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await client.call("need.answer", { needId, ...pick, scope: always ? "project" : "chat" });
    } catch (e) {
      setError(e instanceof ApiCallError ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, answer };
}

/** Your own answer, sent with Enter. */
function OwnAnswer({ busy, onSend }: { busy: boolean; onSend: (text: string) => void }) {
  const [own, setOwn] = useState("");
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing || !own.trim() || busy) return;
    e.preventDefault();
    onSend(own);
  };
  return (
    <input
      className="own"
      aria-label="Your own answer"
      placeholder="Something else…"
      value={own}
      disabled={busy}
      onChange={(e) => setOwn(e.target.value)}
      onKeyDown={onKey}
    />
  );
}

type Answer = (pick: Pick) => void;

/** The details behind the chevron: why it's asked, each option's reasoning, your own words, and Always. */
function Details(p: {
  q: Question;
  busy: boolean;
  answer: Answer;
  always: boolean;
  setAlways: (v: boolean) => void;
}) {
  return (
    <div className="qd">
      {p.q.why && <div className="why">{p.q.why}</div>}
      {p.q.choices.map((c, i) => (
        <button
          type="button"
          key={`${i}-${c.label}`}
          className={`bp-row${c.recommended ? " on" : ""}`}
          disabled={p.busy}
          onClick={() => p.answer({ choice: i + 1 })}
        >
          <span className="g">
            {c.label}
            <small>{c.consequence}</small>
          </span>
        </button>
      ))}
      <div className="qd-f">
        <OwnAnswer busy={p.busy} onSend={(text) => p.answer({ text })} />
        {!p.q.blocked && (
          <label>
            <input type="checkbox" checked={p.always} onChange={(e) => p.setAlways(e.target.checked)} />
            Always for this project
          </label>
        )}
      </div>
    </div>
  );
}

/**
 * An agent's open question, above the message box, as the lab's one-line `.await`: the question and a button per
 * option (the recommended one primary). The chevron opens the details; closed, it stays one line.
 */
export function QuestionBar({ client, question }: { client: IonClient; question: Question }) {
  const [always, setAlways] = useState(false);
  const [open, setOpen] = useState(false);
  const { error, busy, answer } = useAnswer(client, question.needId);
  if (question.resolved) return null;
  const send: Answer = (pick) => void answer(pick, always && !question.blocked);
  return (
    <div className="qwrap" role="group" aria-label="Question">
      {open && <Details q={question} busy={busy} answer={send} always={always} setAlways={setAlways} />}
      <div className="await">
        <span className="g">
          <i className="wd" />
          {question.question}
        </span>
        <button
          type="button"
          className="ib qchev"
          aria-label="Details"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <ChevronUp />
        </button>
        {question.choices.map((c, i) => (
          <button
            type="button"
            key={`${i}-${c.label}`}
            className={`btn${c.recommended ? " pri" : ""}`}
            title={c.consequence}
            disabled={busy}
            onClick={() => send({ choice: i + 1 })}
          >
            {c.label}
          </button>
        ))}
      </div>
      {error && <div className="quiet">{error}</div>}
    </div>
  );
}
