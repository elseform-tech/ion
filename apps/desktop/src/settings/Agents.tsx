import type { IonClient } from "@ion/client/browser";
import { Avatar, Zap } from "@ion/design-system";
import type { HarnessInfo } from "@ion/schema";
import { ready, type SettingsData } from "./data.js";

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

/** One choice of ion's quick model: an agent's own default, or one of its models. */
function Pick(p: {
  spec: string;
  label: string;
  harness: string;
  on: boolean;
  onPick: (spec: string) => void;
}) {
  return (
    <button type="button" className={`chip tog${p.on ? " on" : ""}`} onClick={() => p.onPick(p.spec)}>
      <Avatar harness={p.harness} />
      {p.label}
    </button>
  );
}

/** The model ion thinks with: an agent's own default, or one of its models, from the agents that are ready. */
function QuickModel(p: { data: SettingsData; quick: string; onPick: (spec: string) => void }) {
  return (
    <div>
      <h4>ion’s model</h4>
      <div className="group">
        <div className="srow stack">
          <div className="g">
            <span className="slot">
              <Zap />
              Quick
            </span>
          </div>
          <div className="chips">
            {p.data.harnesses
              .filter(ready)
              .flatMap((h) => [
                <Pick
                  key={h.id}
                  spec={h.id}
                  label={h.label}
                  harness={h.id}
                  on={p.quick === h.id}
                  onPick={p.onPick}
                />,
                ...h.models.map((m) => (
                  <Pick
                    key={`${h.id}:${m.id}`}
                    spec={`${h.id}:${m.id}`}
                    label={m.label}
                    harness={h.id}
                    on={p.quick === `${h.id}:${m.id}`}
                    onPick={p.onPick}
                  />
                )),
              ])}
          </div>
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
