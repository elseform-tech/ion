import { ApiCallError, type IonClient } from "@ion/client/browser";
import { ArrowUp, Square } from "@ion/design-system";
import type { HarnessInfo } from "@ion/schema";
import { type KeyboardEvent, useState } from "react";

const EFFORTS = ["low", "medium", "high", "max"] as const;
type Effort = (typeof EFFORTS)[number];
type Access = "auto" | "full";

/** What the next message runs on: harness, model and effort (the spec's "brain"), and its access mode. */
export type Brain = { harness: string; model: string; effort: "" | Effort; access: "" | Access };

/** One small picker: its label for screen readers, its options as [value, label]. */
function Pick({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
}) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map(([v, text]) => (
        <option key={v} value={v}>
          {text}
        </option>
      ))}
    </select>
  );
}

const cap = (x: string) => x[0]!.toUpperCase() + x.slice(1);

/** The harness, model, effort and access pickers in one row (empty model/effort/access: its own default). */
function BrainPicker({
  harnesses,
  brain,
  onChange,
}: {
  harnesses: HarnessInfo[];
  brain: Brain;
  onChange: (b: Brain) => void;
}) {
  const ready = harnesses.filter((h) => h.installed && h.signedIn);
  const models = ready.find((h) => h.id === brain.harness)?.models ?? [];
  // Agents are checked live (a few seconds); until then, say so rather than show an empty picker.
  const agents: [string, string][] = ready.length
    ? ready.map((h) => [h.id, h.label])
    : [[brain.harness, "Loading agents…"]];
  return (
    <div className="brain">
      <Pick
        label="Agent"
        value={brain.harness}
        options={agents}
        onChange={(v) => onChange({ ...brain, harness: v, model: "" })}
      />
      <Pick
        label="Model"
        value={brain.model}
        options={[["", "Default model"], ...models.map((m): [string, string] => [m.id, m.label])]}
        onChange={(v) => onChange({ ...brain, model: v })}
      />
      <Pick
        label="Effort"
        value={brain.effort}
        options={[["", "Default effort"], ...EFFORTS.map((x): [string, string] => [x, cap(x)])]}
        onChange={(v) => onChange({ ...brain, effort: v as Brain["effort"] })}
      />
      <Pick
        label="Access"
        value={brain.access}
        options={[
          ["", "Project's access"],
          ["auto", "Auto"],
          ["full", "Full access"],
        ]}
        onChange={(v) => onChange({ ...brain, access: v as Brain["access"] })}
      />
    </div>
  );
}

/** A chat to continue, a project for a new chat, or neither (ion's `default`). */
function where(to: { chatId: string } | { projectId: string | null }) {
  if ("chatId" in to) return { chatId: to.chatId };
  return to.projectId ? { projectId: to.projectId } : {};
}

/** The message as `ask` arguments: a chat to continue, or a new chat in a project. */
function askArgs(text: string, brain: Brain, to: { chatId: string } | { projectId: string | null }) {
  return {
    text,
    harness: brain.harness,
    ...where(to),
    ...(brain.model ? { model: brain.model } : {}),
    ...(brain.effort ? { effort: brain.effort } : {}),
    ...(brain.access ? { access: brain.access } : {}),
  };
}

/** Send, or Stop while the chat's run is going. */
function SendOrStop(p: { client: IonClient; running: string | null; canSend: boolean; onSend: () => void }) {
  const running = p.running;
  if (running)
    return (
      <button
        type="button"
        className="send"
        aria-label="Stop"
        onClick={() => void p.client.call("run.interrupt", { runId: running })}
      >
        <Square size={14} />
      </button>
    );
  return (
    <button type="button" className="send" aria-label="Send" disabled={!p.canSend} onClick={p.onSend}>
      <ArrowUp size={16} />
    </button>
  );
}

type Props = {
  client: IonClient;
  harnesses: HarnessInfo[];
  /** A chat to continue, or a new chat in this project (null: ion's default project). */
  to: { chatId: string } | { projectId: string | null };
  /** The run that's going in this chat, to stop it. */
  running: string | null;
  /** The agent the chat last ran on (the default for the next message). */
  harness?: string | null;
  onSent: (chatId: string) => void;
};

/** The message box: what to do, on which brain; Enter sends, Shift+Enter is a new line; Stop while running. */
export function Composer({ client, harnesses, to, running, onSent, harness }: Props) {
  const first = harness ?? harnesses.find((h) => h.installed && h.signedIn)?.id ?? "claude-code";
  const [brain, setBrain] = useState<Brain>({ harness: "", model: "", effort: "", access: "" });
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const b = { ...brain, harness: brain.harness || first };
  const send = async () => {
    if (!text.trim()) return;
    setError(null);
    try {
      const { chatId } = await client.call("ask", askArgs(text, b, to));
      setText("");
      onSent(chatId);
    } catch (e) {
      setError(e instanceof ApiCallError ? e.message : "Something went wrong");
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void send();
  };
  return (
    <div className="composer">
      <textarea
        aria-label="Message"
        placeholder="Reply…"
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
      {error && <div className="composer-error">{error}</div>}
      <div className="composer-row">
        <BrainPicker harnesses={harnesses} brain={b} onChange={setBrain} />
        <SendOrStop
          client={client}
          running={running}
          canSend={Boolean(text.trim())}
          onSend={() => void send()}
        />
      </div>
    </div>
  );
}
