import { ApiCallError, type IonClient } from "@ion/client/browser";
import { ArrowUp, Folder, Square } from "@ion/design-system";
import type { HarnessInfo } from "@ion/schema";
import { type KeyboardEvent, useCallback, useRef, useState } from "react";
import { type Brain, BrainPill, BrainPopover, useEffortKey } from "./BrainPopover.js";
import { useDismiss } from "./dismiss.js";

type Access = "" | "auto" | "full";
const ACCESS: Access[] = ["", "auto", "full"];
const ACCESS_LABEL: Record<Access, string> = { "": "Project's access", auto: "Auto", full: "Full access" };

/** The access pill: the project's own, Auto, or Full access; a click moves to the next. */
function AccessPill({ access, onChange }: { access: Access; onChange: (a: Access) => void }) {
  return (
    <button
      type="button"
      className="pill"
      aria-label={`Access: ${ACCESS_LABEL[access]}`}
      onClick={() => onChange(ACCESS[(ACCESS.indexOf(access) + 1) % ACCESS.length]!)}
    >
      {ACCESS_LABEL[access]}
    </button>
  );
}

/** A new chat's project pill: ion's `default` unless you pick one. */
type ProjectPick = { value: string; options: string[]; onChange: (id: string) => void };
function ProjectPill({ p }: { p: ProjectPick }) {
  return (
    <label className="pill">
      <Folder />
      <select aria-label="Project" value={p.value} onChange={(e) => p.onChange(e.target.value)}>
        {p.options.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The brain pill and its popover, which closes on Escape or a click outside. */
function BrainPick(p: {
  harnesses: HarnessInfo[];
  brain: Brain;
  picked: boolean;
  onChange: (b: Brain) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, wrap, close);
  useEffortKey(p.brain, p.onChange);
  return (
    <span className="bwrap" ref={wrap}>
      <BrainPill harnesses={p.harnesses} brain={p.brain} open={open} onClick={() => setOpen(!open)} />
      {open && (
        <BrainPopover harnesses={p.harnesses} brain={p.brain} picked={p.picked} onChange={p.onChange} />
      )}
    </span>
  );
}

/** A chat to continue, a project for a new chat, or neither (ion's `default`). */
function where(to: { chatId: string } | { projectId: string | null }) {
  if ("chatId" in to) return { chatId: to.chatId };
  return to.projectId ? { projectId: to.projectId } : {};
}

/** The message as `ask` arguments: a chat to continue, or a new chat in a project. */
function askArgs(
  text: string,
  brain: Brain & { access: Access },
  to: { chatId: string } | { projectId: string | null },
) {
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
        <Square />
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
  /** A new chat: its project pill, and the lab's big box. */
  project?: ProjectPick;
  onSent: (chatId: string) => void;
};

/** Sends with `ask` once at a time, keeping ion's refusal to show. */
function useSend(client: IonClient, onSent: (chatId: string) => void) {
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const send = async (args: ReturnType<typeof askArgs>, clear: () => void) => {
    if (sending.current) return;
    sending.current = true;
    setError(null);
    try {
      const { chatId } = await client.call("ask", args);
      clear();
      onSent(chatId);
    } catch (e) {
      setError(e instanceof ApiCallError ? e.message : "Something went wrong");
    } finally {
      sending.current = false;
    }
  };
  return { error, send };
}

/** The lab's message box: what to do, on which brain; Enter sends, Shift+Enter is a new line; Stop while running. */
export function Composer({ client, harnesses, to, running, onSent, harness, project }: Props) {
  // Never a default agent: the chat's own, else the first one ready. Until the list arrives, nothing is sent.
  const ready = harnesses.filter((h) => h.installed && h.signedIn);
  const first = harness ?? ready[0]?.id ?? "";
  const [brain, setBrain] = useState<Brain>({ harness: "", model: "", effort: "" });
  const [access, setAccess] = useState<Access>("");
  const [text, setText] = useState("");
  const { error, send } = useSend(client, onSent);
  const b = { ...brain, harness: brain.harness || first };
  const canSend = Boolean(text.trim()) && ready.some((h) => h.id === b.harness);
  const go = () => canSend && void send(askArgs(text, { ...b, access }, to), () => setText(""));
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    go();
  };
  return (
    <div className={`cbox${project ? " big" : ""}`}>
      <textarea
        aria-label="Message"
        placeholder={project ? "Ask anything, or describe a change…" : "Reply…"}
        rows={project ? 3 : 1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
      {error && <div className="quiet">{error}</div>}
      <div className="bar">
        {project && <ProjectPill p={project} />}
        <BrainPick
          harnesses={harnesses}
          brain={b}
          picked={Boolean(brain.harness || brain.model || brain.effort)}
          onChange={setBrain}
        />
        <AccessPill access={access} onChange={setAccess} />
        <span className="sp" />
        <SendOrStop client={client} running={running} canSend={canSend} onSend={go} />
      </div>
    </div>
  );
}
