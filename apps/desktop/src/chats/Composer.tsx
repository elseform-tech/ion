import { ApiCallError, type IonClient } from "@ion/client/browser";
import { ArrowUp, Folder, type LucideIcon, Shield, ShieldCheck, ShieldOff, Square } from "@ion/design-system";
import type { HarnessInfo } from "@ion/schema";
import { useCallback, useRef, useState } from "react";
import { type Brain, BrainPill, BrainPopover, useEffortKey } from "./BrainPopover.js";
import { useDismiss } from "./dismiss.js";
import { PickChips, PickMenu, pickArgs, usePicker } from "./Picks.js";
import { onEnter, type Queue, QueueLines, useDoubleEsc, useEditInto, useQueue } from "./Queue.js";

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

/** The brain a message goes with: its agent, and the model, effort and access you picked. */
function brainArgs(brain: Brain & { access: Access }) {
  return {
    ...(brain.harness ? { harness: brain.harness } : {}),
    ...(brain.model ? { model: brain.model } : {}),
    ...(brain.effort ? { effort: brain.effort } : {}),
    ...(brain.access ? { access: brain.access } : {}),
  };
}

/** The message as `ask` arguments: a chat to continue, or a new chat in a project. */
function askArgs(
  text: string,
  brain: Brain & { access: Access },
  to: { chatId: string } | { projectId: string | null },
) {
  return { text, ...where(to), ...brainArgs(brain) };
}

/** Send, or Stop while the chat's run is going (Esc twice stops it too). */
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

/**
 * Only a ready agent is a default: the chat's own while it's ready (or while the list loads), else the first one
 * ready. Until the list arrives, nothing is sent.
 */
function defaults(harnesses: HarnessInfo[], harness: string | null | undefined) {
  const ready = harnesses.filter((h) => h.installed && h.signedIn);
  // An agent the app doesn't list (the fake one in the tour): the chat keeps it, and ion sends to the chat's own.
  const unlisted = Boolean(harness && harnesses.length && !harnesses.some((h) => h.id === harness));
  const own =
    harness && (unlisted || !harnesses.length || ready.some((h) => h.id === harness)) ? harness : undefined;
  return { ready, own, first: own ?? ready[0]?.id ?? "", unlisted };
}

/** The brain to send with: what you picked, else the default agent (on its own model when it isn't the chat's). */
const withAgent = (brain: Brain, own: string | undefined, first: string): Brain =>
  brain.harness || own
    ? { ...brain, harness: brain.harness || first }
    : { ...brain, harness: first, model: "" };

/**
 * The box's text: `edit` when you change it (the queue's last refusal goes); `put` when a send takes it or gives it
 * back (`onSending` hears your words on their way, or null when they came back).
 */
function useBoxText(q: Queue, onSending: Props["onSending"]) {
  const [text, setText] = useState("");
  const edit = (t: string) => {
    setText(t);
    q.clearError();
  };
  const put = (t: string) => {
    edit(t);
    onSending?.(t ? null : text);
  };
  return { text, setText, edit, put };
}

/**
 * The brain the box shows (`b`) and the one a message goes with (`sent`): a chat kept on an unlisted agent sends
 * none of its own (ion uses the chat's), unless you pick one. `queued`: a queued message goes later, unattended,
 * so it never switches agents: none unless you picked one (ion uses the chat's, or says why it can't).
 * `agentReady`: it can go.
 */
function useSendBrain(p: Props) {
  const { ready, own, first, unlisted } = defaults(p.harnesses, p.harness);
  const [brain, setBrain] = useBrain(p.to, p.current);
  const [access, setAccess] = useState<Access>("");
  const b = withAgent(brain, own, first);
  const keep = unlisted && !brain.harness;
  const sent = { ...b, access, harness: keep ? "" : b.harness };
  const queued = brain.harness ? sent : { ...brain, access };
  return {
    brain,
    setBrain,
    access,
    setAccess,
    b,
    sent,
    queued,
    agentReady: keep || ready.some((h) => h.id === b.harness),
  };
}

/**
 * The lab's message box: what to do, on which brain; Enter sends, Shift+Enter is a new line; Stop while running.
 * While the run goes, what you send waits in the queue above it (⌘Enter: sends it now).
 */
export function Composer(p: Props) {
  const { client, harnesses, to, running, onSent, project, onBrainOpen, locked } = p;
  useDoubleEsc(running, (runId) => void client.call("run.interrupt", { runId }).catch(() => {}));
  const q = useQueue(client, "chatId" in to ? to : null);
  const { brain, setBrain, access, setAccess, b, sent, queued, agentReady } = useSendBrain(p);
  const { text, setText, edit, put } = useBoxText(q, p.onSending);
  const { error, pending, send } = useSend(client, onSent);
  const pk = usePicker({ client, args: { harness: b.harness, ...where(to) }, text, setText: edit });
  const canSend = !locked && Boolean(text.trim()) && agentReady;
  const { ref, onEdit } = useEditInto(setText);
  const withPicks = <T extends object>(a: T) => ({ ...a, ...pickArgs(pk.picked) });
  const go = () => {
    if (!canSend) return;
    void send(withPicks(askArgs(text, sent, to)), put);
    pk.clear();
  };
  const brainNow = () => {
    if (!canSend) return null;
    const queuedBrain = withPicks(brainArgs(queued));
    pk.clear();
    return queuedBrain;
  };
  const onEnterKey = onEnter({ q, working: Boolean(running), text, setText, send: go, brain: brainNow });
  const shown = error ?? q.error;
  return (
    <>
      <QueueLines q={q} onEdit={onEdit} />
      <div className={`cbox${project ? " big" : ""}`}>
        {pk.menu && <PickMenu menu={pk.menu} />}
        <PickChips picked={pk.picked} onDrop={pk.drop} />
        <textarea
          aria-label="Message"
          ref={ref}
          placeholder={project ? "Ask anything, or describe a change…" : "Reply…"}
          rows={project ? 3 : 1}
          disabled={locked}
          value={text}
          onChange={(e) => {
            edit(e.target.value);
            pk.track(e.target);
          }}
          onSelect={(e) => pk.track(e.currentTarget)}
          onKeyDown={(e) => pk.onKey(e) || onEnterKey(e)}
        />
        {shown && <div className="quiet">{shown}</div>}
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
    </>
  );
}
