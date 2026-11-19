import type { IonClient } from "@ion/client/browser";
import { Avatar, ChevronLeft, ChevronRight, MessageCircle, Zap } from "@ion/design-system";
import { ION_COLORS, type IonInfo, type IonStats, type ProjectInfo, type ProjectPatch } from "@ion/schema";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { ready, type SettingsData } from "./data.js";

const EFFORTS = [
  ["", "Default"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["max", "Max"],
] as const;

const ACCESS = [
  ["auto", "Auto"],
  ["full", "Full access"],
] as const;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="srow">
      <div className="g">{label}</div>
      {children}
    </div>
  );
}

const W = 6;
const G = 2;
const H = 32;

/** Runs per day over 30 days, a bar each (the lab's sparkline). */
function Spark({ s }: { s: IonStats }) {
  const max = Math.max(1, ...s.perDay);
  return (
    <svg
      viewBox={`0 0 ${30 * (W + G) - G} ${H}`}
      width={30 * (W + G) - G}
      height={H}
      role="img"
      aria-label={`${s.runs} runs`}
    >
      {s.perDay.map((v, i) => {
        const h = v ? Math.max(3, (v / max) * H) : 1.5;
        // biome-ignore lint/suspicious/noArrayIndexKey: one bar per day, in order
        return (
          <rect
            key={i}
            x={i * (W + G)}
            y={H - h}
            width={W}
            height={h}
            rx={v ? 2 : 0.75}
            className={v ? "b" : "z"}
          />
        );
      })}
    </svg>
  );
}

/** The lab's stats: runs, succeeded, spent, and runs per day over 30 days. */
function StatCard({ s }: { s: IonStats | null }) {
  const num = (n: string | number, l: string) => (
    <div className="st">
      <b>{n}</b>
      <span>{l}</span>
    </div>
  );
  return (
    <div className="statcard">
      {num(s?.runs ?? 0, "runs")}
      {num(s?.succeeded ?? 0, "succeeded")}
      {num(`$${(s?.costUsd ?? 0).toFixed(2)}`, "spent")}
      <div className="spk">
        <span>Runs per day · 30 days</span>
        {s?.runs ? <Spark s={s} /> : <em>No runs yet</em>}
      </div>
    </div>
  );
}

type Patch = (p: Omit<ProjectPatch, "projectId">) => void;
type SetupProps = { ion: IonInfo; project: ProjectInfo; data: SettingsData; patch: Patch };

/** A project ion's agent (its shape in the ion's colour). Changing it clears the model (it was that agent's). */
function AgentPick({ ion, project, data, patch }: SetupProps) {
  const agent = project.harness ?? ion.harness;
  return (
    <Row label="Agent">
      <div className="hpick" role="radiogroup" aria-label="Agent">
        {data.harnesses.filter(ready).map((h) => (
          <button
            key={h.id}
            type="button"
            role="radio"
            aria-checked={h.id === agent}
            aria-label={h.label}
            title={h.label}
            className={h.id === agent ? "on" : ""}
            onClick={() => patch({ harness: h.id, model: null })}
          >
            <Avatar ion={{ harness: h.id, color: ion.color }} />
          </button>
        ))}
      </div>
    </Row>
  );
}

function ColorPick({ ion, patch }: Pick<SetupProps, "ion" | "patch">) {
  return (
    <Row label="Color">
      <div className="sws" role="radiogroup" aria-label="Color">
        {ION_COLORS.map((c) => (
          <button
            key={c.hex}
            type="button"
            role="radio"
            aria-checked={c.hex === ion.color}
            aria-label={c.name}
            title={c.name}
            className={c.hex === ion.color ? "on" : ""}
            style={{ "--c": c.hex } as CSSProperties}
            onClick={() => patch({ color: c.hex })}
          />
        ))}
      </div>
    </Row>
  );
}

/** The model and effort its threads run on (the agent's own when Default). */
function BrainPick({ ion, project, data, patch }: SetupProps) {
  const agent = data.harnesses.find((h) => h.id === (project.harness ?? ion.harness));
  return (
    <>
      <Row label="Model">
        <div className="chips">
          {[{ id: "", label: "Default" }, ...(agent?.models ?? [])].map((m) => (
            <button
              key={m.id || "default"}
              type="button"
              className={`chip tog${(project.model ?? "") === m.id ? " on" : ""}`}
              onClick={() => patch({ model: m.id || null })}
            >
              {m.label}
            </button>
          ))}
        </div>
      </Row>
      <Row label="Effort">
        <span className="seg sm">
          {EFFORTS.map(([id, label]) => (
            <button
              key={label}
              type="button"
              className={(project.effort ?? "") === id ? "on" : ""}
              onClick={() => patch({ effort: id || null })}
            >
              {label}
            </button>
          ))}
        </span>
      </Row>
    </>
  );
}

/** The project's folder and rules: access, and whether ion chief may read it. */
function Rules({ project, patch }: Pick<SetupProps, "project" | "patch">) {
  const share = project.shareWithIon !== false;
  return (
    <div>
      <h4>Project</h4>
      <div className="group">
        <Row label="Folder">
          <span className="chip mono">{project.path}</span>
        </Row>
        <Row label="Access">
          <span className="seg sm">
            {ACCESS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={(project.access ?? "auto") === id ? "on" : ""}
                onClick={() => patch({ access: id })}
              >
                {label}
              </button>
            ))}
          </span>
        </Row>
        <Row label="Share with ion">
          <button
            type="button"
            className={`sw${share ? " on" : ""}`}
            role="switch"
            aria-checked={share}
            aria-label="Share with ion"
            onClick={() => patch({ shareWithIon: !share })}
          />
        </Row>
      </div>
    </div>
  );
}

/** ion chief's setup: the model it thinks with (set in Agents). */
function ChiefSetup({ quick, onAgents }: { quick: string; onAgents: () => void }) {
  return (
    <Row label="Thinks with">
      <button className="val" type="button" onClick={onAgents}>
        <Zap />
        {quick}
        <ChevronRight />
      </button>
    </Row>
  );
}

type PageProps = {
  client: IonClient;
  data: SettingsData;
  ionId: string;
  onBack: () => void;
  onOpenChat: () => void;
  onAgents: () => void;
};

function Hero({ ion, onOpenChat }: { ion: IonInfo; onOpenChat: () => void }) {
  return (
    <div className="ihero">
      <Avatar ion={ion.ionId === "chief" ? "chief" : { harness: ion.harness, color: ion.color }} />
      <div className="g">
        <h3>{ion.name}</h3>
      </div>
      <button className="btn" type="button" onClick={onOpenChat}>
        <MessageCircle />
        Open chat
      </button>
    </div>
  );
}

/** Settings → an ion: its stats, what it runs on, and its project's rules (ion chief: the model it thinks with). */
export function IonPage(p: PageProps) {
  const ion = p.data.ions.find((x) => x.ionId === p.ionId);
  const project = p.data.projects.find((x) => x.id === p.ionId);
  const [stats, setStats] = useState<IonStats | null>(null);
  useEffect(
    () => void p.client.call("ion.stats", { ionId: p.ionId }).then(setStats, () => {}),
    [p.client, p.ionId],
  );
  if (!ion) return null;
  const patch: Patch = (fields) =>
    void p.client.call("project.update", { projectId: p.ionId, ...fields }).then(p.data.reload, () => {});
  const setup = { ion, data: p.data, patch };
  return (
    <>
      <button className="back" type="button" onClick={p.onBack}>
        <ChevronLeft />
        Ions
      </button>
      <Hero ion={ion} onOpenChat={p.onOpenChat} />
      <StatCard s={stats} />
      <div>
        <h4>Setup</h4>
        <div className="group">
          {project ? (
            <>
              <AgentPick {...setup} project={project} />
              <ColorPick {...setup} />
              <BrainPick {...setup} project={project} />
            </>
          ) : (
            <ChiefSetup quick={p.data.settings?.quick ?? ""} onAgents={p.onAgents} />
          )}
        </div>
      </div>
      {project && <Rules project={project} patch={patch} />}
    </>
  );
}
