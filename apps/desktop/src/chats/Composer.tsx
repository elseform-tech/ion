import { ApiCallError, type IonClient } from "@ion/client/browser";
import { ArrowUp, Folder, type LucideIcon, Shield, ShieldCheck, ShieldOff, Square } from "@ion/design-system";
import type { HarnessInfo } from "@ion/schema";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { AgentSteps } from "../start/AgentSteps.js";
import { type Brain, BrainPill, BrainPopover, useEffortKey } from "./BrainPopover.js";
import { useDismiss } from "./dismiss.js";
import { useEstimate } from "./estimate.js";
import { PickedBox, usePicker } from "./Picks.js";
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
  byUsage?: boolean;
  why?: string | null;
  estimate?: string | null;
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
        byUsage={p.byUsage}
        why={p.why}
        estimate={p.estimate}
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
  /** Pick by usage is on: a new chat you pick no agent for goes on the one ion picks. */
  byUsage?: boolean;
  /** Why Pick by usage put the chat on its agent (its pill says so on hover). */
  why?: string | null;
  /** A new chat you said not to remember (review of #34, 2026-11-23): its first message goes with noMemory. */
  noMemory?: boolean;
  /** Your agents are listed above the box (the first run): with none ready, one line says so instead. */
  agentsAbove?: boolean;
  /** Words put in the box (the first run's first messages; `n` counts picks, so the same one goes in again). */
  seed?: { text: string; n: number } | null;
};

/**
 * With no agent ready, why the box can't send and what to do (Plan 21 audit, 2026-11-23: Send stayed grey with no
 * reason): each agent's install or sign-in command and Check again; under the first run's agents, one line.
 */
function NoAgent(p: Props) {
  if (p.agentsAbove) return <div className="fwait">No agent is ready: install one or sign in above</div>;
  return (
    <div className="fstep">
      <AgentSteps
        client={p.client}
        harnesses={p.harnesses}
        onReload={p.onBrainOpen}
        title="No agent is ready"
      />
    </div>
  );
}

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
  // Pick by usage fills in a new chat's agent only when you picked none (the user, 2026-11-22).
  const byUsage = Boolean(p.byUsage && "projectId" in p.to && !brain.harness);
  const sent = byUsage
    ? { ...b, access, harness: "", model: "" }
    : { ...b, access, harness: keep ? "" : b.harness };
  const queued = brain.harness ? sent : { ...brain, access };
  return {
    brain,
    setBrain,
    access,
    setAccess,
    b,
    sent,
    queued,
    byUsage,
    agentReady: keep || ready.some((h) => h.id === b.harness),
  };
}

/**
 * What a new chat's estimate is asked for: its project, the agent it goes on (none while Pick by usage picks), your
 * words. Nothing until the agents are known and you've typed something; none for a reply.
 */
function estimateAsk(p: Props, harness: string, byUsage: boolean, text: string) {
  if ("chatId" in p.to || !p.harnesses.length || !text.trim()) return null;
  return { projectId: p.to.projectId, ...(byUsage || !harness ? {} : { harness }), text: text.trim() };
}

/** A new chat's big box, or a reply's one line. */
const boxLook = (project?: ProjectPick) =>
  project
    ? { placeholder: "Ask anything, or describe a change…", rows: 3 }
    : { placeholder: "Reply…", rows: 1 };

/**
 * Words the first run put in the box go in; and whether no agent is ready (the agents are known, none is, and the
 * chat isn't kept on one the app doesn't list).
 */
function useNoAgentYet(
  p: Props,
  box: { setText: (t: string) => void; ref: RefObject<HTMLTextAreaElement | null> },
  agentReady: boolean,
): boolean {
  const { setText, ref } = box;
  useEffect(() => {
    if (!p.seed) return;
    setText(p.seed.text);
    // Enter sends it (the tour, 2026-11-23: the picked message stayed focused, and Enter picked it again).
    ref.current?.focus();
  }, [p.seed, setText, ref]);
  return p.harnesses.length > 0 && !p.harnesses.some((h) => h.installed && h.signedIn) && !agentReady;
}

/**
 * The lab's message box: what to do, on which brain; Enter sends, Shift+Enter is a new line; Stop while running.
 * While the run goes, what you send waits in the queue above it (⌘Enter: sends it now).
 */
export function Composer(p: Props) {
  const { client, harnesses, to, running, onSent, project, onBrainOpen, locked } = p;
  useDoubleEsc(running, (runId) => void client.call("run.interrupt", { runId }).catch(() => {}));
  const q = useQueue(client, "chatId" in to ? to : null);
  const { brain, setBrain, access, setAccess, b, sent, queued, byUsage, agentReady } = useSendBrain(p);
  const { text, setText, edit, put } = useBoxText(q, p.onSending);

  const { error, pending, send } = useSend(client, onSent);
  const estimate = useEstimate(client, estimateAsk(p, b.harness, byUsage, text));
  const pk = usePicker({ client, args: { harness: b.harness, ...where(to) }, text, setText: edit });
  const canSend = !locked && Boolean(text.trim()) && agentReady;
  const { ref, onEdit } = useEditInto(setText);
  const noAgent = useNoAgentYet(p, { setText, ref }, agentReady);
  // What you picked goes with the message, sent or queued.
  const args = { ...askArgs(text, sent, to), ...(p.noMemory ? { noMemory: true } : {}) };
  const go = () => canSend && void send(pk.take(args), put);
  const brainNow = () => (canSend ? pk.take(brainArgs(queued)) : null);
  const onEnterKey = onEnter({ q, working: Boolean(running), text, setText, send: go, brain: brainNow });
  const shown = error ?? q.error;
  return (
    <>
      {noAgent && !p.agentsAbove && <NoAgent {...p} />}
      <QueueLines q={q} onEdit={onEdit} />
      <div className={`cbox${project ? " big" : ""}`}>
        <PickedBox
          pk={pk}
          box={{ "aria-label": "Message", ref, ...boxLook(project), disabled: locked, value: text }}
          onEdit={edit}
          onKey={onEnterKey}
        />
        {shown && <div className="quiet">{shown}</div>}
        {noAgent && p.agentsAbove && <NoAgent {...p} />}
        <div className="bar">
          {project && <ProjectPill p={project} />}
          <BrainPick
            onOpen={onBrainOpen}
            harnesses={harnesses}
            brain={b}
            picked={Boolean(brain.harness || brain.model || brain.effort)}
            onChange={setBrain}
            byUsage={byUsage}
            why={p.why}
            estimate={estimate}
          />
          <AccessPill access={access} onChange={setAccess} />
          <span className="sp" />
          <SendOrStop client={client} running={running} canSend={canSend} pending={pending} onSend={go} />
        </div>
      </div>
    </>
  );
}
