import { HOTKEYS } from "../hotkeys.js";

/** Settings → Shortcuts: every hotkey the app handles, from the table the handlers read. */
export function Shortcuts() {
  return (
    <div className="group">
      {HOTKEYS.map((k) => (
        <div key={k.id} className="srow">
          <div className="g">{k.name}</div>
          <span className="keys">
            {k.keys.map((key, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a key can repeat (esc esc); its place is its identity
              <kbd key={i}>{key}</kbd>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}
