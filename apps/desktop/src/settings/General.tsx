import type { IonClient } from "@ion/client/browser";
import { Minus, Plus } from "@ion/design-system";
import type { SettingsInfo, SettingsPatch } from "@ion/schema";
import { useCallError } from "../callError.js";
import type { SettingsData } from "./data.js";
import { ACCESS, Row } from "./IonPage.js";

/** The most chats at once the daemon takes (resources.max_runs). */
const MOST = 32;

type MaxRuns = SettingsInfo["maxRuns"];

/** One step down: 1 goes back to Auto. */
const less = (n: MaxRuns): MaxRuns => (n === "auto" || n <= 1 ? "auto" : n - 1);
/** One step up: Auto is where it starts, then 1. */
const more = (n: MaxRuns): MaxRuns => (n === "auto" ? 1 : Math.min(MOST, n + 1));

/** How many chats work at once: Auto, then 1 to 32, a step at a time. */
function ChatsAtOnce({ value, onPick }: { value: MaxRuns; onPick: (n: MaxRuns) => void }) {
  return (
    <div className="stepper">
      <button
        className="ib"
        type="button"
        title="Less"
        aria-label="Less"
        disabled={value === "auto"}
        onClick={() => onPick(less(value))}
      >
        <Minus />
      </button>
      <span className="n" aria-label="Chats at once">
        {value === "auto" ? "Auto" : value}
      </span>
      <button
        className="ib"
        type="button"
        title="More"
        aria-label="More"
        disabled={value === MOST}
        onClick={() => onPick(more(value))}
      >
        <Plus />
      </button>
    </div>
  );
}

/** Settings → General: the access a new chat starts with, and how many chats work at once. */
export function General({ client, data }: { client: IonClient; data: SettingsData }) {
  const [error, run] = useCallError();
  const s = data.settings;
  if (!s) return null;
  const save = (patch: SettingsPatch) => run(client.call("settings.set", { patch }), data.reload);
  return (
    <div>
      <h4>Chats</h4>
      <div className="group">
        <Row label="Default access">
          <span className="seg sm" role="group" aria-label="Default access">
            {ACCESS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={s.access === id ? "on" : ""}
                onClick={() => save({ access: id })}
              >
                {label}
              </button>
            ))}
          </span>
        </Row>
        <Row label="Chats at once">
          <ChatsAtOnce value={s.maxRuns} onPick={(maxRuns) => save({ maxRuns })} />
        </Row>
        {error && <div className="perr">{error}</div>}
      </div>
    </div>
  );
}
