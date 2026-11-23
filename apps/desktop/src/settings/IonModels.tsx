import { Brain, Gauge, MessagesSquare, Sparkles, Zap } from "@ion/design-system";
import type { EffortLevel, SettingsInfo, SettingsPatch } from "@ion/schema";
import type { SettingsData } from "./data.js";
import { ModelRow } from "./ModelMenu.js";

/** Effort choices: "" is the default (High for ions' thinking, the agent's own for chats). */
const EFFORTS = [
  ["", "Default"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["max", "Max"],
] as const;

/** "Claude Code · opus · High": an agent, its model and an effort, by their names. */
function brainLine(data: SettingsData, b: NonNullable<SettingsInfo["strongest"]>): string {
  const h = data.harnesses.find((x) => x.id === b.agent);
  const model = b.model ? (h?.models.find((m) => m.id === b.model)?.label ?? b.model) : "Default";
  const effort = EFFORTS.find(([id]) => id === b.effort)?.[1] ?? b.effort;
  return [h?.label ?? b.agent, model, effort].join(" · ");
}

type EffortPick = {
  label: string;
  value: EffortLevel | null;
  /** What Default means here. */
  title?: string;
  onPick: (e: EffortLevel | null) => void;
};

/** An effort as buttons (Default first). */
export function EffortSeg(p: EffortPick) {
  return (
    <span className="seg sm" role="group" aria-label={p.label}>
      {EFFORTS.map(([id, label]) => (
        <button
          key={label}
          type="button"
          className={(p.value ?? "") === id ? "on" : ""}
          {...(id || !p.title ? {} : { title: p.title })}
          onClick={() => p.onPick(id || null)}
        >
          {label}
        </button>
      ))}
    </span>
  );
}

/** An effort row of ion's models. */
function EffortRow(p: EffortPick) {
  return (
    <div className="srow">
      <div className="g">
        <span className="slot">
          <Brain />
          Effort
        </span>
      </div>
      <EffortSeg {...p} />
    </div>
  );
}

/** "Chats ions start run on": Automatic, or your pick, and its effort. */
function ChatsRows(p: { data: SettingsData; set: (patch: SettingsPatch) => void }) {
  const s = p.data.settings;
  return (
    <>
      <ModelRow
        {...{
          data: p.data,
          icon: MessagesSquare,
          label: "Chats ions start run on",
          spec: s?.chats ?? "",
          now: null,
        }}
        follow={{ label: "Automatic", icon: Sparkles }}
        onPick={(chats) => p.set({ chats })}
      />
      <EffortRow
        label="Chats' effort"
        title="The agent's own"
        value={s?.chatsEffort ?? null}
        onPick={(chatsEffort) => p.set({ chatsEffort })}
      />
    </>
  );
}

/**
 * The two model settings (the user, 2026-11-24): "Ions think with" (Strongest, which the daemon names, or your pick;
 * for ion chief and every project's ion, routine turns at Medium by themselves) and "Chats ions start run on"
 * (Automatic, or your pick). Your own chats are set in the composer.
 */
export function IonModels(p: {
  data: SettingsData;
  set: (patch: SettingsPatch) => void;
  error: string | null;
}) {
  const s = p.data.settings;
  const strongest = s?.strongest;
  return (
    <div>
      <h4>Models</h4>
      <div className="group">
        <ModelRow
          {...{
            data: p.data,
            icon: Zap,
            label: "Ions think with",
            spec: s?.quick ?? "",
            now: s?.quickNow ?? null,
          }}
          follow={{ label: "Strongest", icon: Gauge }}
          note={!!strongest && `Strongest you have: ${brainLine(p.data, strongest)}`}
          onPick={(quick) => p.set({ quick })}
        />
        <EffortRow
          label="Ions' effort"
          title="High; Medium for routine turns"
          value={s?.effort ?? null}
          onPick={(effort) => p.set({ effort })}
        />
        <ChatsRows data={p.data} set={p.set} />
        {p.error && <div className="perr">{p.error}</div>}
      </div>
    </div>
  );
}
