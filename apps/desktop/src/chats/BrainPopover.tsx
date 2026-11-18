import { Avatar, Check, ChevronUp, Layers, Search } from "@ion/design-system";
import type { HarnessInfo } from "@ion/schema";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

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

/** "OpenCode/Big Pickle" is the model "Big Pickle" from the provider "OpenCode". */
function nameOf(label: string): { name: string; provider: string } {
  const i = label.lastIndexOf("/");
  return i < 0 ? { name: label, provider: "" } : { name: label.slice(i + 1), provider: label.slice(0, i) };
}

const modelLabel = (h: HarnessInfo | undefined, model: string) => {
  const id = model || h?.defaultModel || "";
  return nameOf(h?.models.find((m) => m.id === id)?.label ?? (id || "Default")).name;
};

/** The model to name on the pill: none when it's only the agent's default with no name, or repeats the agent's. */
function pillModel(h: HarnessInfo | undefined, model: string): string | null {
  if (!h || (!model && !h.defaultModel)) return null;
  const name = modelLabel(h, model);
  return name === h.label ? null : name;
}

/**
 * The lab's brain pill, in few words: the agent's avatar and name, the model when it says something, and effort as
 * its bars (all of it named for screen readers). A spinner while the agents are being read.
 */
export function BrainPill(p: { harnesses: HarnessInfo[]; brain: Brain; open: boolean; onClick: () => void }) {
  const h = p.harnesses.find((x) => x.id === p.brain.harness);
  const model = pillModel(h, p.brain.model);
  const effort = `${effortLabel(p.brain.effort)} effort`;
  const name = [h?.label ?? "none", model ?? modelLabel(h, p.brain.model), effort].join(" · ");
  return (
    <button
      type="button"
      className="pill bpill"
      aria-haspopup="dialog"
      aria-expanded={p.open}
      aria-label={`Harness, model and effort: ${name}`}
      title={name}
      onClick={p.onClick}
    >
      {h && <Avatar harness={h.id} />}
      {p.harnesses.length ? <span>{h?.label ?? "No agent"}</span> : <i className="spin" />}
      {model && (
        <>
          <span className="bsep">·</span>
          <span>{model}</span>
        </>
      )}
      <Bars effort={p.brain.effort} />
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

function Rows({ rows, pick }: { rows: Row[]; pick: (key: string) => void }) {
  return (
    <>
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
    </>
  );
}

function Col({ title, rows, pick }: { title: string; rows: Row[]; pick: (key: string) => void }) {
  return (
    <div className="bp-col">
      <div className="bp-h">{title}</div>
      <Rows rows={rows} pick={pick} />
    </div>
  );
}

/** A list this long gets a find field. */
const FIND_FROM = 12;

/** The Model column: each model by name with its provider under it; it scrolls, and a long list can be searched. */
function ModelCol({ rows, pick }: { rows: Row[]; pick: (key: string) => void }) {
  const [q, setQ] = useState("");
  const words = q.trim().toLowerCase();
  const shown = words
    ? rows.filter((r) => `${r.label} ${r.small ?? ""}`.toLowerCase().includes(words))
    : rows;
  return (
    <div className="bp-col bp-models">
      <div className="bp-h">Model</div>
      {rows.length > FIND_FROM && (
        <div className="pmi">
          <Search />
          <input
            type="text"
            placeholder="Find a model"
            aria-label="Find a model"
            autoComplete="off"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      )}
      <div className="bp-scroll">
        <Rows rows={shown} pick={pick} />
      </div>
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

/** The Model column's rows: the agent's default first, then each model by name with its provider. */
function modelRows(h: HarnessInfo | undefined, model: string): Row[] {
  return [
    { key: "", on: !model, label: h?.defaultModel ? modelLabel(h, "") : "Default" },
    ...(h?.models ?? [])
      .filter((m) => m.id !== h?.defaultModel)
      .map((m) => {
        const { name, provider } = nameOf(m.label);
        return { key: m.id, on: model === m.id, label: name, ...(provider ? { small: provider } : {}) };
      }),
  ];
}

/** The popover opens above its pill; where the window is short (a new chat's box sits mid-window), its model list
 * gets shorter so it fits. */
function useFit(harness: string) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const pop = ref.current;
    const list = pop?.querySelector<HTMLElement>(".bp-scroll");
    if (!pop || !list) return;
    list.style.maxHeight = "";
    const over = 8 - pop.getBoundingClientRect().top;
    if (over > 0 && list.offsetHeight) list.style.maxHeight = `${Math.max(96, list.offsetHeight - over)}px`;
  }, [harness]);
  return ref;
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
  const models = modelRows(h, b.model);
  const efforts: Row[] = (["", ...EFFORTS] as Brain["effort"][]).map((e) => ({
    key: e,
    on: b.effort === e,
    label: effortLabel(e),
    lead: <Bars effort={e} />,
  }));
  const ref = useFit(b.harness);
  return (
    <div ref={ref} className="bpop" role="dialog" aria-label="Harness, model and effort">
      <div className="bp-cols">
        <Col title="Harness" rows={harnesses} pick={(k) => p.onChange({ ...b, harness: k, model: "" })} />
        <ModelCol key={b.harness} rows={models} pick={(k) => p.onChange({ ...b, model: k })} />
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
