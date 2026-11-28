import type { IonClient } from "@ion/client/browser";
import { Avatar, CirclePause, Wrench } from "@ion/design-system";
import {
  type AgentUsage,
  EV,
  type HarnessInfo,
  type JudgeCheckInfo,
  type SettingsPatch,
  usageLine,
} from "@ion/schema";
import { Fragment, type ReactNode, useCallback, useEffect, useState } from "react";
import { inOrder, PreferOrder } from "./AgentOrder.js";
import { IonModels } from "./IonModels.js";
import { AgentChecks } from "./AgentChecks.js";
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
 * 16:00", "Free", "No usage info"), with a bar only for a window the agent reports.
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

/** What's worth knowing about an agent, each in a quiet line (how it treats its own tools: under More). */
function AgentNotes({ h, more }: { h: HarnessInfo; more: boolean }) {
  return (
    <>
      {/* Task review, 2026-11-21 (ruled line): it loads a project's own tools by its own trust list. */}
      {more && h.ownTrust && <div className="s">Uses its own trust for project tools</div>}
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

/** An agent's name (with its chip, if any) and whether it's ready. */
function AgentName({ h, chip }: { h: HarnessInfo; chip: string | false | undefined }) {
  return (
    <>
      {h.label}
      {chip && (
        <span className="chip" title={chip}>
          {chip}
        </span>
      )}
      <div className="s">
        {ready(h) && <i className="okd" />}
        {stateOf(h)}
      </div>
    </>
  );
}

/** One of an agent's switches: its icon, named on hover. */
function Toggle(p: {
  icon: ReactNode;
  name: string;
  agent: string;
  on: boolean;
  onPick: (on: boolean) => void;
}) {
  return (
    <span className="swl" title={p.name}>
      {p.icon}
      <Switch
        label={`${p.agent}: ${p.name[0]!.toLowerCase()}${p.name.slice(1)}`}
        on={p.on}
        onPick={p.onPick}
      />
    </span>
  );
}

/** While the agents are first checked (it takes seconds), the box says so instead of standing empty. */
const Checking = () => (
  <div className="srow">
    <i className="spin" />
    <div className="g s">Checking your agents</div>
  </div>
);

/**
 * One agent: its face, name and state, and "Use its own tools" (the user, 2026-11-21: its own servers, skills and
 * plugins in ion's chats, on by default). On: one whose own hooks can't be turned off says they run too. Off: one that
 * has no switch to leave out all its own tools says it loads them too. Plan 21 Task 4: each switch shows under More,
 * or once it isn't as it starts (Avoid on, its own tools off).
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
  /** The page's More is open. */
  more: boolean;
}) {
  const { h, own, onOwn, more } = p;
  const showOwn = more || !own;
  const chip = showOwn && (own ? h.ownHooks && "Its own hooks run too" : h.ownTools && "Also loads its own");
  const sign = useAgentSignIn(p.client, h, p.reload);
  return (
    <div className="hrow">
      <Avatar harness={h.id} />
      <div>
        <AgentName h={h} chip={chip} />
        <AgentNotes h={h} more={more} />
        {p.judge}
      </div>
      {/* The lab's third column: its usage, for an agent that's ready. */}
      {ready(h) ? <UsageMeter u={p.usage} /> : <span />}
      <span className="hacts">
        {sign.action}
        {/* Tour of PR #36, 2026-11-24: two bare toggles; each has its icon and its name on hover. */}
        {(more || p.avoid) && (
          <Toggle
            icon={<CirclePause />}
            name="Avoid unless I ask"
            agent={h.label}
            on={p.avoid}
            onPick={p.onAvoid}
          />
        )}
        {showOwn && (
          <Toggle icon={<Wrench />} name="Use its own tools" agent={h.label} on={own} onPick={onOwn} />
        )}
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
 * Settings → Agents: what ions think with and what their chats run on; each coding agent, whether it's ready, and its
 * usage; Check the agents each night. Under More (Plan 21 Task 4: until used): each agent's Avoid and own-tools switches, Check as judge, and
 * Prefer in this order.
 */
export function Agents({ client, data }: { client: IonClient; data: SettingsData }) {
  const [error, run] = useCallError();
  const set = (patch: SettingsPatch) => run(client.call("settings.set", { patch }), data.reload);
  const usage = useUsage(client, data.harnesses);
  useSignInsWaiting(data.harnesses, data.reload);
  const agents = inOrder(data.harnesses, data.settings?.agentOrder);
  const [more, setMore] = useState(false);
  const judge = useJudgeCheck(client, data, run, more);
  return (
    <>
      <IonModels data={data} set={set} error={error} />
      <div>
        <h4>Coding agents</h4>
        <div className="group">
          {/* Plan 21 Task 4 tour, 2026-11-28 (a fresh home): ~20 s of an empty box. */}
          {!data.harnesses.length && <Checking />}
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
              more={more}
            />
          ))}
        </div>
      </div>
      <AgentChecks client={client} />
      <KeptPicks data={data} set={set} />
      {data.settings && (
        <PreferOrder
          agents={agents}
          prefer={data.settings.prefer ?? []}
          onOrder={(ids) => set({ agentOrder: ids })}
          more={more}
          onMore={setMore}
        />
      )}
    </>
  );
}

/** "Codex · luna": an agent and model by their names. */
function named(data: SettingsData, spec: string): string {
  const [id, ...rest] = spec.split(":");
  const h = data.harnesses.find((x) => x.id === id);
  return [h?.label ?? id, rest.join(":")].filter(Boolean).join(" · ");
}

/**
 * A judge or Dream agent you set before (an older config; PR #36 final review, 2026-11-24): one quiet line each, with
 * a way back to automatic.
 */
function KeptPicks({ data, set }: { data: SettingsData; set: (patch: SettingsPatch) => void }) {
  const s = data.settings;
  const lines: [string, SettingsPatch][] = [];
  if (s?.judge)
    lines.push([
      `Judge: yours, ${named(data, s.judge)}${s.judgeChecked ? "" : " · not checked"}`,
      { judge: null },
    ]);
  if (s?.dream?.agent)
    lines.push([`Tidy memory: yours, ${named(data, s.dream.agent)}`, { dream: { agent: null } }]);
  if (!lines.length) return null;
  return (
    <div className="group">
      {lines.map(([text, patch]) => (
        <div key={text} className="srow">
          <div className="g s">{text}</div>
          <button className="btn" type="button" onClick={() => set(patch)}>
            Back to automatic
          </button>
        </div>
      ))}
    </div>
  );
}

/** Why a check didn't pass: what it allowed, or that it didn't answer enough (PR #36 final review, 2026-11-24). */
const whyNot = (l: { dangerous: string[] }) =>
  l.dangerous.length ? `allowed ${l.dangerous.length} dangerous` : "didn't answer enough";

/** What a judge is, on hover. */
const JUDGE = "The judge decides Auto's calls that ion isn't sure about";

/** What a check that didn't pass says before its link, or nothing. */
const failedLine = (l: JudgeCheckInfo | null) => (l && !l.pass ? `Not a judge: ${whyNot(l)} · ` : "");

/**
 * Each agent's judge line (the user, 2026-11-24: the judge is automatic, checked on your Mac): "Checked as judge",
 * "Checking as judge…", what a failed check allowed, or (under More) a small "Check as judge" for a ready agent with a
 * judge model (free ones are checked by themselves).
 */
function useJudgeCheck(
  client: IonClient,
  data: SettingsData,
  run: ReturnType<typeof useCallError>[1],
  more: boolean,
) {
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
    // "judge" is clarified on hover (Plan 21 Task 3): what it does, never as hint text.
    if (j.checked)
      return (
        <div className="s" title={JUDGE}>
          Checked as judge
        </div>
      );
    if (j.checking || going.includes(h.id)) return <div className="s">Checking as judge…</div>;
    // Plan 21, 2026-11-28: ion's own check stopped at the agent's limit; you can check it again yourself.
    const failed = j.ranOut ? "Its free use ran out during the check · " : failedLine(j.last);
    // Plan 21 Task 4: Check as judge waits under More; a check that failed still says so.
    if (!more) return failed ? <div className="s">{failed.slice(0, -3)}</div> : null;
    return (
      <div className="s">
        {failed}
        <button
          className="lnk"
          type="button"
          title={`${JUDGE}\nRuns ion's judge cases on ${j.model}; uses your plan`}
          onClick={() => check(h.id)}
        >
          Check as judge
        </button>
      </div>
    );
  };
}
