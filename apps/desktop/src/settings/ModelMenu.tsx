import { Avatar, List } from "@ion/design-system";
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
  /** "Your order" first (on: none is set; `now`: the agent that is, marked), and picking it goes back to it. */
  follow?: { on: boolean; now: string | null; onPick: () => void };
}) {
  const f = p.follow;
  return (
    <div className="hpick" role="radiogroup" aria-label={p.label ?? "Agent"}>
      {f && (
        <button
          type="button"
          role="radio"
          aria-checked={f.on}
          aria-label="Your order"
          title="Your order"
          className={f.on ? "on" : ""}
          onClick={f.onPick}
        >
          <List />
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
