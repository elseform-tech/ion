import type { IonClient } from "@ion/client/browser";
import { Moon } from "@ion/design-system";
import type { DreamInfo, DreamMode, MemoryInfo, SettingsPatch } from "@ion/schema";
import type { Run } from "../callError.js";
import { type SettingsData, ready } from "./data.js";
import { AgentPicker } from "./ModelMenu.js";

const MODES: [DreamMode, string][] = [
  ["off", "Off"],
  ["nightly", "Nightly"],
  ["weekly", "Weekly"],
];
const DAY_MS = 86_400_000;

/** ion's dream changed this file in the last day (its row says Tidied by ion). */
export const tidiedByIon = (m: MemoryInfo, now = Date.now()) =>
  m.source === "ion:_dream" && now - Date.parse(m.writtenAt) < DAY_MS;

/**
 * Dream: ion tidies memory overnight (off, nightly or weekly), on an agent you pick (ion's own model's unless you do).
 */
export function DreamRow(p: { client: IonClient; data: SettingsData; run: Run }) {
  const s = p.data.settings;
  if (!s) return null;
  const save = (dream: NonNullable<SettingsPatch["dream"]>) =>
    p.run(p.client.call("settings.set", { patch: { dream } }), () => p.data.reload());
  const agent = (s.dream.agent ?? s.quickNow ?? "").split(":")[0];
  return (
    <div className="group">
      <div className="srow">
        <div className="g">
          <span className="slot">
            <Moon />
            Dream
          </span>
        </div>
        {s.dream.mode !== "off" && (
          <AgentPicker
            agents={p.data.harnesses.filter(ready)}
            value={agent}
            onPick={(id) => save({ agent: id })}
          />
        )}
        <span className="seg sm" role="group" aria-label="Dream">
          {MODES.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={s.dream.mode === id ? "on" : ""}
              onClick={() => save({ mode: id })}
            >
              {label}
            </button>
          ))}
        </span>
      </div>
    </div>
  );
}

/** What ion's dream forgot in the last day, each with Restore; and the notes it left you. */
export function Tidied(p: { tidied: DreamInfo | null; client: IonClient; run: Run }) {
  const t = p.tidied;
  if (!t || (!t.forgotten.length && !t.notes.length)) return null;
  return (
    <div className="group">
      {t.forgotten.map((f) => (
        <div className="srow" key={f.path}>
          <div className="g">{`Forgot “${f.name}”`}</div>
          <button
            className="btn"
            type="button"
            onClick={() => p.run(p.client.call("memory.restore", { path: f.path }))}
          >
            Restore
          </button>
        </div>
      ))}
      {t.notes.map((n) => (
        <div className="srow" key={n}>
          <div className="g s">{n}</div>
        </div>
      ))}
    </div>
  );
}
