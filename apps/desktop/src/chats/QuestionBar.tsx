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

/**
 * An agent's open question, above the message box (the spec's "a single prompt sits above its message box"):
 * the question, why it's asked, each option with its reasoning and tradeoffs (the agent's pick marked), a box for
 * your own answer, and whether the answer holds for the whole project.
 */
export function QuestionBar({ client, question }: { client: IonClient; question: Question }) {
  const [always, setAlways] = useState(false);
  const [own, setOwn] = useState("");
  const { error, busy, answer } = useAnswer(client, question.needId);
  if (question.resolved) return null;
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing || !own.trim() || busy) return;
    e.preventDefault();
    void answer({ text: own }, always);
  };
  return (
    <div className="qcard" role="group" aria-label="Question">
      <div className="qcard-q">{question.question}</div>
      {question.why && <div className="qcard-why">{question.why}</div>}
      <div className="qcard-options">
        {question.choices.map((c, i) => (
          <button
            type="button"
            key={`${i}-${c.label}`}
            className={`qcard-option${c.recommended ? " qcard-option--rec" : ""}`}
            disabled={busy}
            onClick={() => void answer({ choice: i + 1 }, always)}
          >
            <span className="qcard-label">
              {c.label}
              {c.recommended && <span className="qcard-rec">Recommended</span>}
            </span>
            <span className="qcard-detail">{c.consequence}</span>
          </button>
        ))}
      </div>
      <div className="qcard-foot">
        <input
          className="qcard-own"
          aria-label="Your own answer"
          placeholder="Something else…"
          value={own}
          disabled={busy}
          onChange={(e) => setOwn(e.target.value)}
          onKeyDown={onKey}
        />
        <label className="qcard-always">
          <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
          Always for this project
        </label>
      </div>
      {error && <div className="qbar-error">{error}</div>}
    </div>
  );
}
