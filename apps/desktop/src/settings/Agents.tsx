import type { IonClient } from "@ion/client/browser";
import { Avatar } from "@ion/design-system";
import { type AgentUsage, EV, type HarnessInfo, type SettingsPatch, usageLine } from "@ion/schema";
import { Fragment, type ReactNode, useCallback, useEffect, useState } from "react";
import { inOrder, PreferOrder } from "./AgentOrder.js";
import { IonModels } from "./IonModels.js";
import { useEvents } from "../events.js";
import { useCallError } from "../callError.js";
import { ready, type SettingsData } from "./data.js";
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

/** What's worth knowing about an agent, each in a quiet line. */
function AgentNotes({ h }: { h: HarnessInfo }) {
  return (
    <>
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
    </>
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
  /** "Avoid unless I ask" (the user, 2026-11-24): Automatic never picks it. */
  avoid: boolean;
  onAvoid: (on: boolean) => void;
  /** Its judge line: checked, being checked, or a small "Check as judge". */
  judge: ReactNode;
}) {
  const { h, own, onOwn } = p;
  const chip = own ? h.ownHooks && "Its own hooks run too" : h.ownTools && "Also loads its own";
  const sign = useAgentSignIn(p.client, h, p.reload);
  return (
    <div className="hrow">
      <Avatar harness={h.id} />
      <div>
        {h.label}
        {chip && <span className="chip">{chip}</span>}
        <div className="s">
          {ready(h) && <i className="okd" />}
          {stateOf(h)}
        </div>
        <AgentNotes h={h} />
        {p.judge}
      </div>
      {/* The lab's third column: its usage, for an agent that's ready. */}
      {ready(h) ? <UsageMeter u={p.usage} /> : <span />}
      <span className="hacts">
        {sign.action}
        <Switch
          label={`${h.label}: avoid unless I ask`}
          title="Avoid unless I ask"
          on={p.avoid}
          onPick={p.onAvoid}
        />
        <Switch label={`${h.label}: use its own tools`} title="Use its own tools" on={own} onPick={onOwn} />
      </span>
      {sign.panel}
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
  const judge = useJudgeCheck(client, data, run);
  return (
    <>
      <IonModels data={data} set={set} error={error} />
      <div>
        <h4>Coding agents</h4>
        <div className="group">
          {agents.map((h) => (
            <AgentRow
              key={h.id}
              client={client}
              reload={data.reload}
              h={h}
              usage={usage.find((u) => u.harness === h.id)}
              own={data.settings?.ownTools?.[h.id] ?? true}
              onOwn={(on) => set({ ownTools: { [h.id]: on } })}
              avoid={!!data.settings?.avoid?.[h.id]}
              onAvoid={(on) => set({ avoid: { [h.id]: on } })}
              judge={judge(h)}
            />
          ))}
        </div>
      </div>
      {data.settings && (
        <PreferOrder
          agents={agents}
          prefer={data.settings.prefer ?? []}
          onOrder={(ids) => set({ agentOrder: ids })}
        />
      )}
    </>
  );
}

/**
 * Each agent's judge line (the user, 2026-11-24: the judge is automatic, checked on your Mac): "Checked as judge",
 * "Checking as judge…", what a failed check allowed, or a small "Check as judge" for a ready agent with a judge model
 * (free ones are checked by themselves).
 */
function useJudgeCheck(client: IonClient, data: SettingsData, run: ReturnType<typeof useCallError>[1]) {
  const [going, setGoing] = useState<string[]>([]);
  const check = (id: string) => {
    setGoing((g) => [...g, id]);
    run(
      client.call("judge.check", { harness: id }).finally(() => setGoing((g) => g.filter((x) => x !== id))),
      data.reload,
    );
  };
  return (h: HarnessInfo): ReactNode => {
    const j = data.settings?.judges?.[h.id];
    if (!j || !ready(h)) return null;
    if (j.checked) return <div className="s">Checked as judge</div>;
    if (j.checking || going.includes(h.id)) return <div className="s">Checking as judge…</div>;
    const failed = j.last && !j.last.pass ? `Not a judge (allowed ${j.last.dangerous.length}) · ` : "";
    return (
      <div className="s">
        {failed}
        <button
          className="lnk"
          type="button"
          title={`Runs ion's judge cases on ${j.model}; uses your plan`}
          onClick={() => check(h.id)}
        >
          Check as judge
        </button>
      </div>
    );
  };
}
