import { Avatar, List, type LucideIcon } from "@ion/design-system";
import { ready, type SettingsData } from "./data.js";
import type { HarnessInfo } from "@ion/schema";

/** One menu of an agent's models; "Default" (the empty value) is the agent's own. A long list stays one line. */
export function ModelMenu(p: {
  models: HarnessInfo["models"];
  value: string;
  onChange: (model: string) => void;
  /** Its name for screen readers (default "Model"). */
  label?: string;
}) {
  return (
    <select
      className="val"
      aria-label={p.label ?? "Model"}
      value={p.value}
      onChange={(e) => p.onChange(e.target.value)}
    >
      <option value="">Default</option>
      {p.models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
    </select>
  );
}

/** An agent's button: picked ("on"), the one "Your order" runs on now ("now"), or neither. */
function classOf(id: string, value: string | null | undefined, now: string | null | undefined): string {
  if (id === value) return "on";
  return id === now ? "now" : "";
}

/** The agents that are ready, as their shapes (in an ion's colour, when given); one is picked. */
export function AgentPicker(p: {
  agents: HarnessInfo[];
  value: string | null | undefined;
  color?: string | null;
  onPick: (id: string) => void;
  /** Its name for screen readers (default "Agent"). */
  label?: string;
  /**
   * What none picked follows first ("Your order", or "Strongest"; on: none is set; `now`: the agent it's on, marked),
   * and picking it goes back to it.
   */
  follow?: { label: string; icon: LucideIcon; on: boolean; now: string | null; onPick: () => void };
}) {
  const f = p.follow;
  return (
    <div className="hpick" role="radiogroup" aria-label={p.label ?? "Agent"}>
      {f && (
        <button
          type="button"
          role="radio"
          aria-checked={f.on}
          aria-label={f.label}
          title={f.label}
          className={f.on ? "on" : ""}
          onClick={f.onPick}
        >
          <f.icon />
        </button>
      )}
      {p.agents.map((h) => (
        <button
          key={h.id}
          type="button"
          role="radio"
          aria-checked={h.id === p.value}
          aria-label={h.label}
          title={h.label}
          className={classOf(h.id, p.value, f?.now)}
          onClick={() => p.onPick(h.id)}
        >
          {p.color === undefined ? (
            <Avatar harness={h.id} />
          ) : (
            <Avatar ion={{ harness: h.id, color: p.color }} />
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * One of ion's own models: "Your order" (none set: it follows your agent order, the agent it's on now marked), or an
 * agent (its shape), then one of its models from a menu ("Default": the agent's own). Only agents that are ready.
 */
export function ModelRow(p: {
  data: SettingsData;
  icon: LucideIcon;
  label: string;
  /** Yours ("" when none is set), and whom it runs on now (the daemon says). */
  spec: string;
  now: string | null;
  onPick: (spec: string | null) => void;
  /** A quiet line under it (the judge on a model ion's evals didn't check; the strongest model you have). */
  note?: string | false;
  /** What "none picked" is called and drawn as: your agent order (the default), or the strongest model you have. */
  follow?: { label: string; icon: LucideIcon };
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
        follow={{
          ...(p.follow ?? { label: "Your order", icon: List }),
          on: !p.spec,
          now: p.spec ? null : (agent ?? null),
          onPick: () => p.onPick(null),
        }}
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
