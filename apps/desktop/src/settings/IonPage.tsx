import type { IonClient } from "@ion/client/browser";
import {
  Avatar,
  Check,
  ChevronLeft,
  ChevronRight,
  MessageCircle,
  Sparkles,
  X,
  Zap,
} from "@ion/design-system";
import {
  ION_COLORS,
  type IonInfo,
  type IonStats,
  type ProjectInfo,
  type ProjectPatch,
  stripControl,
} from "@ion/schema";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { useCallError } from "../callError.js";
import { ready, type SettingsData } from "./data.js";
import { AgentPicker, ModelMenu } from "./ModelMenu.js";
import { EffortSeg } from "./IonModels.js";
import { More } from "./More.js";
import { Routines } from "./Routines.js";

/** Effort choices: "" is the agent's own default. */

export function Row({ label, children }: { label: string; children: ReactNode }) {
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

/**
 * Under More (the user, 2026-11-24): what the chats this project's ion starts run on, over "Chats ions start run on":
 * Default (that setting), or an agent with a model and effort. The ion itself thinks with "Ions think with". Changing
 * the agent clears the model (it was that agent's). Shown without More once set.
 */
function ChatsOverride(p: SetupProps & { more: boolean; onMore: (open: boolean) => void }) {
  const { ion, project, data, patch } = p;
  const open = p.more || !!project.harness;
  const agent = data.harnesses.find((h) => h.id === project.harness);
  return (
    <>
      <More open={p.more} onOpen={p.onMore} />
      {open && (
        <>
          <Row label="Its chats run on">
            <AgentPicker
              agents={data.harnesses.filter(ready)}
              value={project.harness ?? null}
              color={ion.color}
              label="Its chats run on"
              follow={{
                label: "Default",
                icon: Sparkles,
                on: !project.harness,
                now: null,
                onPick: () => patch({ harness: null, model: null, effort: null }),
              }}
              onPick={(h) => patch({ harness: h, model: null })}
            />
          </Row>
          {agent && (
            <Row label="Model">
              <ModelMenu
                models={agent.models}
                value={project.model ?? ""}
                onChange={(m) => patch({ model: m || null })}
              />
            </Row>
          )}
          <Row label="Effort">
            <EffortSeg
              label="Its chats' effort"
              value={project.effort ?? null}
              onPick={(effort) => patch({ effort })}
            />
          </Row>
        </>
      )}
    </>
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

const PROFILE_MAX = 300;

/** What the project's ion suggested as its profile: only used once you accept it. */
function Suggested({ text, patch }: { text: string; patch: Patch }) {
  return (
    <div className="srow">
      <Sparkles />
      <div className="g s">{text}</div>
      <button
        className="ib"
        type="button"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={() => patch({ profileSuggestion: null })}
      >
        <X />
      </button>
      <button
        className="ib"
        type="button"
        aria-label="Accept"
        title="Accept"
        onClick={() => patch({ profile: text, profileSuggestion: null })}
      >
        <Check />
      </button>
    </div>
  );
}

/** What the project is, in your words (saved when you leave the box), and what its ion suggested. */
function Profile({ project, patch }: Pick<SetupProps, "project" | "patch">) {
  const saved = stripControl(project.profile ?? "");
  const [text, setText] = useState(saved);
  const [long, setLong] = useState(false);
  useEffect(() => setText(saved), [saved]);
  const save = () => {
    const t = text.trim();
    setLong(t.length > PROFILE_MAX);
    if (t.length <= PROFILE_MAX && t !== saved) patch({ profile: t || null });
  };
  const suggested = stripControl(project.profileSuggestion ?? "").trim();
  return (
    <>
      <div className="srow stack">
        <div className="g">Profile</div>
        <textarea
          className="fin"
          aria-label="Profile"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={save}
        />
        {long && <div className="perr">Keep it under 300 characters</div>}
      </div>
      {suggested && <Suggested text={suggested} patch={patch} />}
    </>
  );
}

/** The project's folder and rules: whether ion chief may read it. */
function Rules({ project, patch, error }: Pick<SetupProps, "project" | "patch"> & { error: ReactNode }) {
  const share = project.shareWithIon !== false;
  return (
    <div>
      <h4>Project</h4>
      <div className="group">
        <Row label="Folder">
          <span className="chip mono">{project.path}</span>
        </Row>
        <Profile project={project} patch={patch} />
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
        {error}
      </div>
    </div>
  );
}

/** ion chief's setup: what ions think with, set in Settings → Agents (the user, 2026-11-24). */
function ChiefSetup({ quick, onAgents }: { quick: string; onAgents: () => void }) {
  return (
    <Row label="Thinks with">
      <button className="val" type="button" onClick={onAgents}>
        <Zap />
        {quick || "Strongest"}
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

/** An ion's stats, read when its page opens. */
function useIonStats(client: IonClient, ionId: string): IonStats | null {
  const [stats, setStats] = useState<IonStats | null>(null);
  useEffect(() => void client.call("ion.stats", { ionId }).then(setStats, () => {}), [client, ionId]);
  return stats;
}

/** Settings → an ion: its stats, what it runs on, and its project's rules (ion chief: the model it thinks with). */
export function IonPage(p: PageProps) {
  const ion = p.data.ions.find((x) => x.ionId === p.ionId);
  const project = p.data.projects.find((x) => x.id === p.ionId);
  const stats = useIonStats(p.client, p.ionId);
  const [error, run] = useCallError();
  const [at, setAt] = useState<"setup" | "rules">("setup");
  // Plan 21 Task 4: its chats' agent and its routines wait under More until it has them.
  const [more, setMore] = useState(false);
  if (!ion) return null;
  // Why a change didn't save shows under the group it was made in.
  const patchIn =
    (where: typeof at): Patch =>
    (fields) => {
      setAt(where);
      run(p.client.call("project.update", { projectId: p.ionId, ...fields }), p.data.reload);
    };
  const patch = patchIn("rules");
  const setup = { ion, data: p.data, patch: patchIn("setup") };
  const shown = (where: typeof at) => error && at === where && <div className="perr">{error}</div>;
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
              <ColorPick {...setup} />
              <ChatsOverride {...setup} project={project} more={more} onMore={setMore} />
            </>
          ) : (
            <ChiefSetup quick={p.data.settings?.quickNow ?? ""} onAgents={p.onAgents} />
          )}
          {shown("setup")}
        </div>
      </div>
      {project && <Rules project={project} patch={patch} error={shown("rules")} />}
      {project && (more || !!project.routines?.length) && (
        <Routines client={p.client} project={project} onChanged={p.data.reload} />
      )}
    </>
  );
}
