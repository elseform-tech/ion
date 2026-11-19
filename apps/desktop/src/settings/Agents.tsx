import type { IonClient } from "@ion/client/browser";
import { Avatar, Zap } from "@ion/design-system";
import type { HarnessInfo } from "@ion/schema";
import { ready, type SettingsData } from "./data.js";
import { AgentPicker, ModelMenu } from "./ModelMenu.js";

/** An agent's state, in plain words. */
function stateOf(h: HarnessInfo): string {
  if (ready(h)) return "Signed in";
  return h.installed ? "Not signed in" : "Not installed";
}

function AgentRow({ h }: { h: HarnessInfo }) {
  return (
    <div className="hrow">
      <Avatar harness={h.id} />
      <div>
        {h.label}
        <div className="s">
          {ready(h) && <i className="okd" />}
          {stateOf(h)}
        </div>
      </div>
    </div>
  );
}

/**
 * The model ion thinks with: an agent (its shape), then one of its models from a menu ("Default": the agent's
 * own). Only agents that are ready.
 */
function QuickModel(p: { data: SettingsData; quick: string; onPick: (spec: string) => void }) {
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
      </div>
    </div>
  );
}

/** Settings → Agents: each coding agent and whether it's ready; the model ion thinks with. */
export function Agents({ client, data }: { client: IonClient; data: SettingsData }) {
  const quick = data.settings?.quick ?? "";
  const pick = (spec: string) =>
    void client.call("settings.update", { quick: spec }).then(data.reload, () => {});
  return (
    <>
      <div>
        <h4>Coding agents</h4>
        <div className="group">
          {data.harnesses.map((h) => (
            <AgentRow key={h.id} h={h} />
          ))}
        </div>
      </div>
      <QuickModel data={data} quick={quick} onPick={pick} />
    </>
  );
}
