import { ApiCallError, type IonClient } from "@ion/client/browser";
import { ArrowUp, Folder, type LucideIcon, Shield, ShieldCheck, ShieldOff, Square } from "@ion/design-system";
import type { HarnessInfo } from "@ion/schema";
import { type KeyboardEvent, useCallback, useRef, useState } from "react";
import { type Brain, BrainPill, BrainPopover, useEffortKey } from "./BrainPopover.js";
import { useDismiss } from "./dismiss.js";

type Access = "" | "auto" | "full";
const ACCESS: Access[] = ["", "auto", "full"];
const ACCESS_LABEL: Record<Access, string> = { "": "Project's access", auto: "Auto", full: "Full access" };

const ACCESS_ICON: Record<Access, LucideIcon> = { "": Shield, auto: ShieldCheck, full: ShieldOff };

/**
 * The access pill: a shield (the project's own, Auto checked, Full access open), named on hover, picked on purpose
 * from a list that lies over it.
 */
function AccessPill({ access, onChange }: { access: Access; onChange: (a: Access) => void }) {
  const Icon = ACCESS_ICON[access];
  return (
    <label className={["pill", "apill", access].filter(Boolean).join(" ")} title={ACCESS_LABEL[access]}>
      <Icon />
      <select aria-label="Access" value={access} onChange={(e) => onChange(e.target.value as Access)}>
        {ACCESS.map((a) => (
          <option key={a} value={a}>
            {ACCESS_LABEL[a]}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A new chat's project pill: ion's `default` unless you pick one. */
type ProjectPick = { value: string; options: { id: string; name: string }[]; onChange: (id: string) => void };
function ProjectPill({ p }: { p: ProjectPick }) {
  return (
    <label className="pill">
      <Folder />
      <select aria-label="Project" value={p.value} onChange={(e) => p.onChange(e.target.value)}>
        {p.options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The brain pill and its popover, which closes on Escape or a click outside. */
function BrainPick(p: {
  onOpen?: () => void;
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
      <BrainPill
        harnesses={p.harnesses}
        brain={p.brain}
        open={open}
        onClick={() => {
          if (!open) p.onOpen?.();
          setOpen(!open);
        }}
      />
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
function SendOrStop(p: {
  client: IonClient;
  running: string | null;
  canSend: boolean;
  pending: boolean;
  onSend: () => void;
}) {
  const running = p.running;
  if (p.pending)
    return (
      <button type="button" className="send sending" aria-label="Sending" disabled>
        <ArrowUp />
      </button>
    );
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
  /** The chat's latest model and effort (what its pill shows until you pick). */
  current?: { model: string | null; effort: string | null };
  /** A new chat: its project pill, and the lab's big box. */
  project?: ProjectPick;
  /** Your message is on its way (its text), or came back refused (null). */
  onSending?: (text: string | null) => void;
  /** An agent's question waits: it's answered in its panel, so the box is locked. */
  locked?: boolean;
  /** The brain popover opened: read the agents again. */
  onBrainOpen?: () => void;
  onSent: (chatId: string) => void;
};

/**
 * Sends with `ask` once at a time. Your words leave the box at once (ion can take a moment to start the run) and
 * come back, with ion's refusal, if it says no.
 */
function useSend(client: IonClient, onSent: (chatId: string) => void) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const sending = useRef(false);
  const send = async (args: ReturnType<typeof askArgs>, put: (text: string) => void) => {
    if (sending.current) return;
    sending.current = true;
    setPending(true);
    setError(null);
    put("");
    try {
      const { chatId } = await client.call("ask", args);
      onSent(chatId);
    } catch (e) {
      put(args.text);
      setError(e instanceof ApiCallError ? e.message : "Something went wrong");
    } finally {
      sending.current = false;
      setPending(false);
    }
  };
  return { error, pending, send };
}

/** Your brain picks per chat, for the window's life: a chat's composer drawn again keeps them. */
const picks = new Map<string, Brain>();

/** An open chat's brain: what you picked for it (kept while the window is open), else its latest model and effort. */
function useBrain(to: Props["to"], current: Props["current"]): [Brain, (b: Brain) => void] {
  const key = "chatId" in to ? to.chatId : null;
  const [brain, setPicked] = useState<Brain>(
    () =>
      (key && picks.get(key)) || {
        harness: "",
        model: current?.model ?? "",
        effort: (current?.effort ?? "") as Brain["effort"],
      },
  );
  const set = (b: Brain) => {
    if (key) picks.set(key, b);
    setPicked(b);
  };
  return [brain, set];
}

/** The lab's message box: what to do, on which brain; Enter sends, Shift+Enter is a new line; Stop while running. */
export function Composer(p: Props) {
  const { client, harnesses, to, running, onSent, harness, project, onBrainOpen, locked, onSending } = p;
  // Only a ready agent is a default: the chat's own while it's ready (or while the list loads), else the first
  // one ready, on its own model. Until the list arrives, nothing is sent.
  const ready = harnesses.filter((h) => h.installed && h.signedIn);
  const own = harness && (!harnesses.length || ready.some((h) => h.id === harness)) ? harness : undefined;
  const first = own ?? ready[0]?.id ?? "";
  const [brain, setBrain] = useBrain(to, p.current);
  const [access, setAccess] = useState<Access>("");
  const [text, setText] = useState("");
  const { error, pending, send } = useSend(client, onSent);
  const b =
    brain.harness || own
      ? { ...brain, harness: brain.harness || first }
      : { ...brain, harness: first, model: "" };
  const canSend = !locked && Boolean(text.trim()) && ready.some((h) => h.id === b.harness);
  const put = (t: string) => {
    setText(t);
    onSending?.(t ? null : text);
  };
  const go = () => canSend && void send(askArgs(text, { ...b, access }, to), put);
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
        disabled={locked}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
      {error && <div className="quiet">{error}</div>}
      <div className="bar">
        {project && <ProjectPill p={project} />}
        <BrainPick
          onOpen={onBrainOpen}
          harnesses={harnesses}
          brain={b}
          picked={Boolean(brain.harness || brain.model || brain.effort)}
          onChange={setBrain}
        />
        <AccessPill access={access} onChange={setAccess} />
        <span className="sp" />
        <SendOrStop client={client} running={running} canSend={canSend} pending={pending} onSend={go} />
      </div>
    </div>
  );
}
