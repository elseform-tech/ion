import { ApiCallError, type IonClient } from "@ion/client/browser";
import { ChevronDown, ChevronUp, Star } from "@ion/design-system";
import { stripControl } from "@ion/schema";
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

/** Why ion stopped a call, and its exact input: at most 3 lines, all of it on a click. */
function Why({ text }: { text: string }) {
  const [full, setFull] = useState(false);
  return (
    <div
      className={`why${full ? "" : " clamp"}`}
      role="button"
      tabIndex={0}
      aria-expanded={full}
      title={full ? undefined : text}
      onClick={() => setFull(!full)}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setFull(!full)}
    >
      {text}
    </div>
  );
}

/** The open panel's body: a stopped call's reason and input, one line per option, your own words, and Always. */
function Details(p: {
  q: Question;
  busy: boolean;
  answer: Answer;
  always: boolean;
  setAlways: (v: boolean) => void;
}) {
  return (
    <div className="qd">
      {/* An agent's question carries its context itself; a call ion stopped shows what it would run. */}
      {p.q.blocked && p.q.why && <Why text={p.q.why} />}
      {p.q.choices.map((c, i) => (
        <button
          type="button"
          key={`${i}-${c.label}`}
          className="qopt"
          title={c.consequence}
          disabled={p.busy}
          onClick={() => p.answer({ choice: i + 1 })}
        >
          <b>{c.label}</b>
          <span>{c.consequence}</span>
          {c.recommended && <Star className="rec" aria-label="Recommended" />}
        </button>
      ))}
      <div className="qd-f">
        <OwnAnswer busy={p.busy} onSend={(text) => p.answer({ text })} />
        <Keep q={p.q} on={p.always} set={p.setAlways} />
      </div>
    </div>
  );
}

/**
 * Keeping the answer: Always (for this project) on an agent's question; Remember on a call ion stopped (the user,
 * 2026-11-21: kept for this exact action in this project), none when its input was cut.
 */
function Keep({ q, on, set }: { q: Question; on: boolean; set: (v: boolean) => void }) {
  if (q.blocked && q.noRemember) return null;
  const [label, word] = q.blocked ? ["Remember", "Remember"] : ["Always for this project", "Always"];
  return (
    <label title={label}>
      <input type="checkbox" aria-label={label} checked={on} onChange={(e) => set(e.target.checked)} />
      {word}
    </label>
  );
}

const ON_BAR = 2;

/**
 * The options a collapsed panel shows. ion's own question about a call it stopped shows them all, so saying no is
 * always there. An agent's question shows the first two, with the recommended one kept.
 */
function onBar(q: Question) {
  const all = q.choices.map((c, i) => ({ c, i }));
  if (q.blocked) return all;
  const rec = all.find((x) => x.c.recommended);
  const first = all.slice(0, ON_BAR);
  if (!rec || first.includes(rec)) return first;
  return [...first.slice(0, ON_BAR - 1), rec];
}

/** A collapsed panel's buttons: one per option it shows, the recommended one primary. */
function BarButtons({ q, busy, answer }: { q: Question; busy: boolean; answer: Answer }) {
  return (
    <>
      {onBar(q).map(({ c, i }) => (
        <button
          type="button"
          key={`${i}-${c.label}`}
          className={`btn${c.recommended ? " pri" : ""}`}
          title={c.consequence}
          disabled={busy}
          onClick={() => answer({ choice: i + 1 })}
        >
          {c.label}
        </button>
      ))}
    </>
  );
}

/**
 * An agent's open question, in one panel above the message box, open: the question, each option with its
 * reasoning, your own words and Always. Collapsed, it's one line with a button per option.
 */
/** Everything an agent wrote, without control or invisible direction characters (they could disguise a command). */
function clean(q: Question): Question {
  return {
    ...q,
    question: stripControl(q.question),
    ...(q.why ? { why: stripControl(q.why) } : {}),
    ...(q.note ? { note: stripControl(q.note) } : {}),
    choices: q.choices.map((c) => ({
      ...c,
      label: stripControl(c.label),
      consequence: stripControl(c.consequence),
    })),
  };
}

export function QuestionBar({ client, question: raw }: { client: IonClient; question: Question }) {
  const question = clean(raw);
  const [always, setAlways] = useState(false);
  const [open, setOpen] = useState(true);
  const { error, busy, answer } = useAnswer(client, question.needId);
  if (question.resolved) return null;
  const send: Answer = (pick) => void answer(pick, always && !question.noRemember);
  return (
    <div className="qbox" role="group" aria-label="Question">
      <div className="qhead">
        <span className="qq" title={question.question}>
          {question.question}
        </span>
        {!open && <BarButtons q={question} busy={busy} answer={send} />}
        <button
          type="button"
          className="ib"
          aria-label={open ? "Collapse" : "Expand"}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDown /> : <ChevronUp />}
        </button>
      </div>
      {question.note && <div className="qnote">{question.note}</div>}
      {open && <Details q={question} busy={busy} answer={send} always={always} setAlways={setAlways} />}
      {error && <div className="quiet">{error}</div>}
    </div>
  );
}
