import type { IonClient } from "@ion/client/browser";
import { Avatar, Brain, Zap } from "@ion/design-system";
import type { EffortLevel, HarnessInfo } from "@ion/schema";
import { useCallError } from "../callError.js";
import { ready, type SettingsData } from "./data.js";
import { EFFORTS } from "./IonPage.js";
import { AgentPicker, ModelMenu } from "./ModelMenu.js";
import { Switch } from "./Switch.js";

/** An agent's state, in plain words. */
function stateOf(h: HarnessInfo): string {
  if (ready(h)) return "Signed in";
  return h.installed ? "Not signed in" : "Not installed";
}

/**
 * One agent: its face, name and state, and "Use its own tools" (the user, 2026-11-21: its own servers, skills and
 * plugins in ion's chats, on by default). On: one whose own hooks can't be turned off says they run too. Off: one that
 * has no switch to leave out all its own tools says it loads them too.
 */
function AgentRow({ h, own, onOwn }: { h: HarnessInfo; own: boolean; onOwn: (on: boolean) => void }) {
  const chip = own ? h.ownHooks && "Its own hooks run too" : h.ownTools && "Also loads its own";
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
        {/* Task review, 2026-11-21 (ruled line): it loads a project's own tools by its own trust list. */}
        {h.ownTrust && <div className="s">Uses its own trust for project tools</div>}
        {/* Plan 18 Task 12: its chats run without the OS sandbox on this computer. */}
        {h.notSandboxed && <div className="s">Not sandboxed</div>}
      </div>
      {/* The lab's third column (its usage meter) stays empty here; the switch sits where the lab's does. */}
      <span />
      <Switch label={`${h.label}: use its own tools`} title="Use its own tools" on={own} onPick={onOwn} />
    </div>
  );
}

/**
 * The model ion thinks with: an agent (its shape), then one of its models from a menu ("Default": the agent's
 * own). Only agents that are ready.
 */
function QuickModel(p: {
  data: SettingsData;
  quick: string;
  onPick: (spec: string) => void;
  error: string | null;
  /** More rows of ion's model (its effort). */
  children?: React.ReactNode;
}) {
  const [agent, model = ""] = p.quick.split(/:(.*)/);
  const ok = p.data.harnesses.filter(ready);
  const models = ok.find((h) => h.id === agent)?.models ?? [];
  return (
    <div>
      <h4>ion’s model</h4>
      <div className="group">
        <div className="srow">
          <div className="g">
            <span className="slot">
              <Zap />
              Quick
            </span>
          </div>
          <AgentPicker agents={ok} value={agent} onPick={p.onPick} />
          <ModelMenu
            models={models}
            value={model}
            onChange={(m) => p.onPick(m ? `${agent}:${m}` : String(agent))}
          />
        </div>
        {p.children}
        {p.error && <div className="perr">{p.error}</div>}
      </div>
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

/** Settings → Agents: each coding agent and whether it's ready; the model ion thinks with, and how hard. */
export function Agents({ client, data }: { client: IonClient; data: SettingsData }) {
  const quick = data.settings?.quick ?? "";
  const [error, run] = useCallError();
  const pick = (spec: string) => run(client.call("settings.set", { patch: { quick: spec } }), data.reload);
  return (
    <>
      <div>
        <h4>Coding agents</h4>
        <div className="group">
          {data.harnesses.map((h) => (
            <AgentRow
              key={h.id}
              h={h}
              own={data.settings?.ownTools?.[h.id] ?? true}
              onOwn={(on) =>
                run(client.call("settings.set", { patch: { ownTools: { [h.id]: on } } }), data.reload)
              }
            />
          ))}
        </div>
      </div>
      <QuickModel data={data} quick={quick} onPick={pick} error={error}>
        <QuickEffort
          value={data.settings?.effort ?? null}
          onPick={(effort) => run(client.call("settings.set", { patch: { effort } }), data.reload)}
        />
      </QuickModel>
    </>
  );
}
