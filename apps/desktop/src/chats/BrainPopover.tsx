import { Avatar, Check, ChevronUp, Layers } from "@ion/design-system";
import type { HarnessInfo } from "@ion/schema";
import { useEffect } from "react";

const EFFORTS = ["low", "medium", "high", "max"] as const;
type Effort = (typeof EFFORTS)[number];

/** What the next message runs on: harness, model and effort (the spec's "brain"); empty: the agent's own default. */
export type Brain = { harness: string; model: string; effort: "" | Effort };

const cap = (x: string) => x[0]!.toUpperCase() + x.slice(1);
const effortLabel = (e: Brain["effort"]) => (e ? cap(e) : "Default");

/** The lab's effort bars: one to four lit. */
function Bars({ effort }: { effort: Brain["effort"] }) {
  const n = effort ? EFFORTS.indexOf(effort) + 1 : 0;
  return (
    <span className="ebars" aria-hidden="true">
      {[1, 2, 3, 4].map((i) => (
        <i key={i} className={i <= n ? "on" : ""} />
      ))}
    </span>
  );
}

const modelLabel = (h: HarnessInfo | undefined, model: string) => {
  const id = model || h?.defaultModel || "";
  return h?.models.find((m) => m.id === id)?.label ?? (id || "Default");
};

/** The lab's brain pill: avatar, agent · model · effort bars and effort, chevron. */
export function BrainPill(p: { harnesses: HarnessInfo[]; brain: Brain; open: boolean; onClick: () => void }) {
  const h = p.harnesses.find((x) => x.id === p.brain.harness);
  return (
    <button
      type="button"
      className="pill bpill"
      aria-haspopup="dialog"
      aria-expanded={p.open}
      aria-label={`Harness, model and effort: ${h?.label ?? "none"}`}
      onClick={p.onClick}
    >
      {h && <Avatar harness={h.id} />}
      <span>{h?.label ?? (p.harnesses.length ? "No agent" : "Loading agents…")}</span>
      <span className="bsep">·</span>
      <span>{modelLabel(h, p.brain.model)}</span>
      <span className="bsep">·</span>
      <Bars effort={p.brain.effort} />
      <span>{effortLabel(p.brain.effort)}</span>
      <ChevronUp className="bchev" />
    </button>
  );
}

function unready(h: HarnessInfo): string {
  if (!h.installed) return "Not installed";
  return h.signedIn ? "" : "Not signed in";
}

type Row = {
  key: string;
  on: boolean;
  label: string;
  small?: string;
  disabled?: boolean;
  lead?: React.ReactNode;
};

function Col({ title, rows, pick }: { title: string; rows: Row[]; pick: (key: string) => void }) {
  return (
    <div className="bp-col">
      <div className="bp-h">{title}</div>
      {rows.map((r) => (
        <button
          type="button"
          key={r.key}
          className={`bp-row${r.on ? " on" : ""}`}
          disabled={r.disabled}
          onClick={() => pick(r.key)}
        >
          {r.lead}
          <span className="g">
            {r.label}
            {r.small && <small>{r.small}</small>}
          </span>
          {r.on && <Check className="ck" />}
        </button>
      ))}
    </div>
  );
}

/** ⌘. (Ctrl+. elsewhere) moves to the next effort, wherever the focus is. */
export function useEffortKey(brain: Brain, onChange: (b: Brain) => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== ".") return;
      e.preventDefault();
      const next = EFFORTS[(EFFORTS.indexOf(brain.effort as Effort) + 1) % EFFORTS.length]!;
      onChange({ ...brain, effort: next });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [brain, onChange]);
}

/** The lab's `.bpop`: Harness, Model and Effort columns; agents not ready are disabled and say why. */
export function BrainPopover(p: {
  harnesses: HarnessInfo[];
  brain: Brain;
  picked: boolean;
  onChange: (b: Brain) => void;
}) {
  const b = p.brain;
  const h = p.harnesses.find((x) => x.id === b.harness);
  const harnesses: Row[] = p.harnesses.map((x) => ({
    key: x.id,
    on: x.id === b.harness,
    label: x.label,
    small: unready(x),
    disabled: Boolean(unready(x)),
    lead: <Avatar harness={x.id} />,
  }));
  const models: Row[] = [
    { key: "", on: !b.model, label: h?.defaultModel ? modelLabel(h, "") : "Default" },
    ...(h?.models ?? [])
      .filter((m) => m.id !== h?.defaultModel)
      .map((m) => ({ key: m.id, on: b.model === m.id, label: m.label })),
  ];
  const efforts: Row[] = (["", ...EFFORTS] as Brain["effort"][]).map((e) => ({
    key: e,
    on: b.effort === e,
    label: effortLabel(e),
    lead: <Bars effort={e} />,
  }));
  return (
    <div className="bpop" role="dialog" aria-label="Harness, model and effort">
      <div className="bp-cols">
        <Col title="Harness" rows={harnesses} pick={(k) => p.onChange({ ...b, harness: k, model: "" })} />
        <Col title="Model" rows={models} pick={(k) => p.onChange({ ...b, model: k })} />
        <Col title="Effort" rows={efforts} pick={(k) => p.onChange({ ...b, effort: k as Brain["effort"] })} />
      </div>
      <div className="bp-f">
        <Layers />
        <span>
          {effortLabel(b.effort)} · from <b>{p.picked ? "this chat" : (h?.label ?? "the agent")}</b>
        </span>
      </div>
    </div>
  );
}
