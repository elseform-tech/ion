import type { IonClient } from "@ion/client/browser";
import { Avatar, Brain, type LucideIcon, ShieldCheck, Zap } from "@ion/design-system";
import {
  type AgentUsage,
  EV,
  type EffortLevel,
  type HarnessInfo,
  type SettingsPatch,
  usageLine,
} from "@ion/schema";
import { Fragment, type HTMLAttributes, type ReactNode, useCallback, useEffect, useState } from "react";
import { inOrder, PickingAgents, useAgentOrder } from "./AgentOrder.js";
import { useEvents } from "../events.js";
import { useCallError } from "../callError.js";
import { ready, type SettingsData } from "./data.js";
import { EFFORTS } from "./IonPage.js";
import { AgentPicker, ModelMenu } from "./ModelMenu.js";
import { Switch } from "./Switch.js";
import { useAgentSignIn, useSignInsWaiting } from "./AgentSignIn.js";

/** An agent's state, in plain words. */
function stateOf(h: HarnessInfo): string {
  if (ready(h)) return "Signed in";
  if (h.installed && h.signInUnknown) return "Couldn't tell if it's signed in";
  return h.installed ? "Not signed in" : "Not installed";
}

/**
 * The lab's meter: its usage in one quiet line (the user, 2026-11-21: "62% of 5 h · resets 14:20", "limited until
 * 16:00", "Free", "Learned from errors"), with a bar only for a window the agent reports.
 */
function UsageMeter({ u }: { u: AgentUsage | undefined }) {
  if (!u) return <span />;
  const line = usageLine(u, new Date());
  const hi = line.limited || (line.percent ?? 0) >= 80;
  return (
    <div className={`meter${hi ? " hi" : ""}`}>
      {/* Tour, 2026-11-22: "resets Mon 01:57" broke across lines; it wraps only between its parts. */}
      <span>
        {line.text.split(" · ").map((part, i) => (
          <Fragment key={part}>
            {i ? " · " : ""}
            <span className="mp">{part}</span>
          </Fragment>
        ))}
      </span>
      {line.percent !== null && (
        <div className="tr">
          <i style={{ width: `${line.percent}%` }} />
        </div>
      )}
    </div>
  );
}

/**
 * One agent: its face, name and state, and "Use its own tools" (the user, 2026-11-21: its own servers, skills and
 * plugins in ion's chats, on by default). On: one whose own hooks can't be turned off says they run too. Off: one that
 * has no switch to leave out all its own tools says it loads them too.
 */
function AgentRow(p: {
  client: IonClient;
  reload: () => void;
  h: HarnessInfo;
  usage?: AgentUsage;
  own: boolean;
  onOwn: (on: boolean) => void;
  /** Its grip in your agent order, and where a drag lands. */
  grip: ReactNode;
  row: HTMLAttributes<HTMLDivElement>;
}) {
  const { h, own, onOwn } = p;
  const chip = own ? h.ownHooks && "Its own hooks run too" : h.ownTools && "Also loads its own";
  const sign = useAgentSignIn(p.client, h, p.reload);
  return (
    <div className="hrow ord" {...p.row}>
      {p.grip}
      <Avatar harness={h.id} />
      <div>
        {h.label}
        {chip && <span className="chip">{chip}</span>}
        <div className="s">
          {ready(h) && <i className="okd" />}
          {stateOf(h)}
        </div>
        {/* Task review, 2026-11-21 (ruled line): it loads a project's own tools by its own trust list. */}
        {h.ownTrust && <div className="s">Uses its own trust for project tools</div>}
        {/* Plan 18 Task 12: its chats run without the OS sandbox on this computer. */}
        {h.notSandboxed && <div className="s">Not sandboxed</div>}
        {/* Plan 18 Task 14: its own allow and deny rules count as your decisions in its chats. */}
        {h.ownRules ? <div className="s">Uses its own allow/deny rules ({h.ownRules})</div> : null}
        {/* Final review, 2026-11-22: how often its judge didn't answer (too slow, or failed) this week. */}
        {h.judgeMisses ? (
          <div className="s">
            Judge didn't answer {h.judgeMisses === 1 ? "once" : `${h.judgeMisses} times`} this week
          </div>
        ) : null}
      </div>
      {/* The lab's third column: its usage, for an agent that's ready. */}
      {ready(h) ? <UsageMeter u={p.usage} /> : <span />}
      <span className="hacts">
        {sign.action}
        <Switch label={`${h.label}: use its own tools`} title="Use its own tools" on={own} onPick={onOwn} />
      </span>
      {sign.panel}
    </div>
  );
}

/**
 * One of ion's own models: "Your order" (none set: it follows your agent order, the agent it's on now marked), or an
 * agent (its shape), then one of its models from a menu ("Default": the agent's own). Only agents that are ready.
 */
function ModelRow(p: {
  data: SettingsData;
  icon: LucideIcon;
  label: string;
  /** Yours ("" when none is set), and whom it runs on now (the daemon says). */
  spec: string;
  now: string | null;
  onPick: (spec: string | null) => void;
  /** A quiet line under it (the judge on a model ion's evals didn't check). */
  note?: string | false;
}) {
  const [agent, model = ""] = (p.spec || p.now || "").split(/:(.*)/);
  const ok = p.data.harnesses.filter(ready);
  const models = ok.find((h) => h.id === agent)?.models ?? [];
  const Icon = p.icon;
  return (
    <div className="srow">
      <div className="g">
        <span className="slot">
          <Icon />
          {p.label}
        </span>
        {p.note && <div className="s">{p.note}</div>}
      </div>
      <AgentPicker
        agents={ok}
        value={p.spec ? agent : null}
        onPick={p.onPick}
        label={p.label}
        follow={{ on: !p.spec, now: p.spec ? null : (agent ?? null), onPick: () => p.onPick(null) }}
      />
      <ModelMenu
        label={`${p.label} model`}
        models={models}
        value={p.spec ? model : ""}
        onChange={(m) => p.onPick(m ? `${agent}:${m}` : String(agent))}
      />
    </div>
  );
}

/** How hard ion's own model thinks (Default: its agent's own). */
function QuickEffort({
  value,
  onPick,
}: {
  value: EffortLevel | null;
  onPick: (e: EffortLevel | null) => void;
}) {
  return (
    <div className="srow">
      <div className="g">
        <span className="slot">
          <Brain />
          Effort
        </span>
      </div>
      <span className="seg sm" role="group" aria-label="ion's effort">
        {EFFORTS.map(([id, label]) => (
          <button
            key={label}
            type="button"
            className={(value ?? "") === id ? "on" : ""}
            onClick={() => onPick(id || null)}
          >
            {label}
          </button>
        ))}
      </span>
    </div>
  );
}

/** ion's own models: Quick and its effort, and Auto's judge (Plan 21 audit, 2026-11-23: it was Claude Code, unseen). */
function IonModels(p: { data: SettingsData; set: (patch: SettingsPatch) => void; error: string | null }) {
  const s = p.data.settings;
  return (
    <div>
      <h4>ion’s models</h4>
      <div className="group">
        <ModelRow
          {...{ data: p.data, icon: Zap, label: "Quick", spec: s?.quick ?? "", now: s?.quickNow ?? null }}
          onPick={(quick) => p.set({ quick })}
        />
        <QuickEffort value={s?.effort ?? null} onPick={(effort) => p.set({ effort })} />
        <ModelRow
          {...{
            data: p.data,
            icon: ShieldCheck,
            label: "Judge",
            spec: s?.judge ?? "",
            now: s?.judgeNow ?? null,
          }}
          note={!!s?.judge && !s.judgeChecked && "Not checked by ion’s evals"}
          onPick={(judge) => p.set({ judge })}
        />
        {p.error && <div className="perr">{p.error}</div>}
      </div>
    </div>
  );
}

/** What changes an agent's usage line: its usage, a limit it hit, a run or turn that ended (it may clear one). */
const changesUsage = (e: { type: string; data: unknown }) =>
  e.type === EV.usageReported ||
  e.type === EV.runFinished ||
  (e.type === EV.error && !!(e.data as { limit?: unknown } | null)?.limit);

/**
 * Each ready agent's usage, read again whenever the agents are, and when it changes while Settings is open (review,
 * 2026-11-22: a limit hit meanwhile didn't show).
 */
function useUsage(client: IonClient, harnesses: HarnessInfo[]): AgentUsage[] {
  const [usage, setUsage] = useState<AgentUsage[]>([]);
  const read = useCallback(() => void client.call("usage.list", {}).then(setUsage, () => {}), [client]);
  useEffect(read, [read, harnesses]);
  useEvents(
    client,
    useCallback((e) => changesUsage(e) && read(), [read]),
  );
  return usage;
}

/**
 * Settings → Agents: each coding agent and whether it's ready, in your order (drag to change it); what ion does when
 * one hits its limit, and Pick by usage; the model ion thinks with, and how hard.
 */
export function Agents({ client, data }: { client: IonClient; data: SettingsData }) {
  const [error, run] = useCallError();
  const set = (patch: SettingsPatch) => run(client.call("settings.set", { patch }), data.reload);
  const usage = useUsage(client, data.harnesses);
  useSignInsWaiting(data.harnesses, data.reload);
  const agents = inOrder(data.harnesses, data.settings?.agentOrder);
  const order = useAgentOrder(
    agents.map((h) => h.id),
    (ids) => run(client.call("settings.set", { patch: { agentOrder: ids } }), data.reload),
  );
  return (
    <>
      <div>
        <h4>Coding agents</h4>
        <div className="group">
          {agents.map((h, i) => (
            <AgentRow
              key={h.id}
              client={client}
              reload={data.reload}
              h={h}
              usage={usage.find((u) => u.harness === h.id)}
              own={data.settings?.ownTools?.[h.id] ?? true}
              onOwn={(on) =>
                run(client.call("settings.set", { patch: { ownTools: { [h.id]: on } } }), data.reload)
              }
              grip={order.grip(i, h.label)}
              row={order.rowProps(i)}
            />
          ))}
        </div>
        {data.settings && (
          <PickingAgents
            client={client}
            onLimit={data.settings.onLimit ?? "ask"}
            byUsage={data.settings.byUsage ?? false}
            run={(call) => run(call, data.reload)}
          />
        )}
      </div>
      <IonModels data={data} set={set} error={error} />
    </>
  );
}
