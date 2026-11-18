import { ApiCallError, type IonClient } from "@ion/client/browser";
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

/** The options, each with its reasoning and tradeoffs; the agent's own pick marked. */
function Options({ q, busy, onPick }: { q: Question; busy: boolean; onPick: (n: number) => void }) {
  return (
    <div className="qcard-options">
      {q.choices.map((c, i) => (
        <button
          type="button"
          key={`${i}-${c.label}`}
          className={`qcard-option${c.recommended ? " qcard-option--rec" : ""}`}
          disabled={busy}
          onClick={() => onPick(i + 1)}
        >
          <span className="qcard-label">
            {c.label}
            {c.recommended && <span className="qcard-rec">Recommended</span>}
          </span>
          <span className="qcard-detail">{c.consequence}</span>
        </button>
      ))}
    </div>
  );
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
      className="qcard-own"
      aria-label="Your own answer"
      placeholder="Something else…"
      value={own}
      disabled={busy}
      onChange={(e) => setOwn(e.target.value)}
      onKeyDown={onKey}
    />
  );
}

/**
 * An agent's open question, above the message box (the spec's "a single prompt sits above its message box"):
 * the question, why it's asked, each option with its reasoning and tradeoffs, a box for your own answer, and
 * whether the answer holds for the whole project. ion's own question about a call it stopped has no "always" box
 * (its options say it), and says when ion went on without your answer.
 */
export function QuestionBar({ client, question }: { client: IonClient; question: Question }) {
  const [always, setAlways] = useState(false);
  const { error, busy, answer } = useAnswer(client, question.needId);
  if (question.resolved) return null;
  return (
    <div className="qcard" role="group" aria-label="Question">
      {question.expired && (
        <div className="qcard-expired">
          ion said no after 4 minutes, and the agent went on. Your answer still counts.
        </div>
      )}
      <div className="qcard-q">{question.question}</div>
      {question.why && <div className="qcard-why">{question.why}</div>}
      <Options q={question} busy={busy} onPick={(n) => void answer({ choice: n }, always)} />
      <div className="qcard-foot">
        <OwnAnswer busy={busy} onSend={(text) => void answer({ text }, always)} />
        {!question.blocked && (
          <label className="qcard-always">
            <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
            Always for this project
          </label>
        )}
      </div>
      {error && <div className="qbar-error">{error}</div>}
    </div>
  );
}
