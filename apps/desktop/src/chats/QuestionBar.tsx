import { ApiCallError, type IonClient } from "@ion/client/browser";
import { Button } from "@ion/design-system";
import { useState } from "react";
import type { Item } from "./timeline.js";

type Question = Extract<Item, { kind: "question" }>;

/**
 * An agent's open question, above the message box (the spec's "a single prompt sits above its message box"):
 * one button per choice, and whether the answer holds for the whole project.
 */
export function QuestionBar({ client, question }: { client: IonClient; question: Question }) {
  const [always, setAlways] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (question.answered) return null;
  const answer = async (n: number) => {
    setBusy(true);
    setError(null);
    try {
      await client.call("need.answer", {
        needId: question.needId,
        choice: n,
        scope: always ? "project" : "chat",
      });
    } catch (e) {
      setError(e instanceof ApiCallError ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="qbar">
      <div className="qbar-q">
        <span className="qbar-dot" aria-hidden />
        {question.question}
      </div>
      {question.why && <div className="qbar-why">{question.why}</div>}
      <div className="qbar-choices">
        {question.choices.map((c, i) => (
          <Button
            key={c.label}
            variant={i === 0 ? "primary" : "ghost"}
            disabled={busy}
            title={c.consequence}
            onClick={() => void answer(i + 1)}
          >
            {c.label}
          </Button>
        ))}
        <label className="qbar-always">
          <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
          Always for this project
        </label>
      </div>
      {error && <div className="qbar-error">{error}</div>}
    </div>
  );
}
