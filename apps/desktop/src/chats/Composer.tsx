import { ApiCallError, type IonClient } from "@ion/client/browser";
import { ArrowUp, Square } from "@ion/design-system";
import type { HarnessInfo } from "@ion/schema";
import { type KeyboardEvent, useRef, useState } from "react";

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

/** The agent's own default model by name when it says which; otherwise whose default it is. */
function defaultModelLabel(h: HarnessInfo | undefined): string {
  if (!h?.defaultModel) return `${h?.label ?? "The agent"}'s default`;
  return `${h.models.find((m) => m.id === h.defaultModel)?.label ?? h.defaultModel} (default)`;
}

/**
 * The agents ready to use. Until they're checked (a few seconds), "Loading agents…"; the chat's own agent stays
 * shown (and is what's sent) even when it isn't ready now.
 */
function agentOptions(all: HarnessInfo[], ready: HarnessInfo[], chosen: string): [string, string][] {
  const agents: [string, string][] = ready.map((h) => [h.id, h.label]);
  if (!all.length) agents.push([chosen, "Loading agents…"]);
  else if (chosen && !ready.some((h) => h.id === chosen)) agents.push([chosen, `${chosen} (not ready)`]);
  return agents;
}

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
  const current = ready.find((h) => h.id === brain.harness);
  const models = current?.models ?? [];
  const defaultLabel = defaultModelLabel(current);
  const agents = agentOptions(harnesses, ready, brain.harness);
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
        options={[["", defaultLabel], ...models.map((m): [string, string] => [m.id, m.label])]}
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
  // Never a default agent: the chat's own, else the first one ready. Until the list arrives, nothing is sent.
  const first = harness ?? harnesses.find((h) => h.installed && h.signedIn)?.id ?? "";
  const [brain, setBrain] = useState<Brain>({ harness: "", model: "", effort: "", access: "" });
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const b = { ...brain, harness: brain.harness || first };
  const canSend = Boolean(text.trim()) && harnesses.length > 0 && Boolean(b.harness);
  const send = async () => {
    if (!canSend || sending.current) return;
    sending.current = true;
    setError(null);
    try {
      const { chatId } = await client.call("ask", askArgs(text, b, to));
      setText("");
      onSent(chatId);
    } catch (e) {
      setError(e instanceof ApiCallError ? e.message : "Something went wrong");
    } finally {
      sending.current = false;
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
        <SendOrStop client={client} running={running} canSend={canSend} onSend={() => void send()} />
      </div>
    </div>
  );
}
