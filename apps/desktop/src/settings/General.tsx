import type { IonClient } from "@ion/client/browser";
import { Minus, Plus } from "@ion/design-system";
import type { SettingsInfo } from "@ion/schema";
import { useEffect, useState } from "react";
import { useCallError } from "../callError.js";
import type { SettingsData } from "./data.js";
import { Row } from "./IonPage.js";

/** The fewest and most chats at once the daemon takes (resources.max_runs). */
const FEWEST = 1;
const MOST = 32;

type MaxRuns = SettingsInfo["maxRuns"];

/**
 * One step from `n` (Auto counts as the number it means here, `auto`): landing on that number is Auto again, so
 * stepping through it is how you go back.
 */
function step(n: MaxRuns, by: 1 | -1, auto: number): MaxRuns {
  const next = Math.min(MOST, Math.max(FEWEST, (n === "auto" ? auto : n) + by));
  return next === auto ? "auto" : next;
}

/** How many chats work at once: Auto (as many as the daemon says), or 1 to 32, a step at a time. */
function ChatsAtOnce({
  value,
  auto,
  onPick,
}: {
  value: MaxRuns;
  auto: number;
  onPick: (n: MaxRuns) => void;
}) {
  const now = value === "auto" ? auto : value;
  const button = (by: 1 | -1) => (
    <button
      className="ib"
      type="button"
      title={by > 0 ? "More" : "Less"}
      aria-label={by > 0 ? "More" : "Less"}
      disabled={by > 0 ? now >= MOST : now <= FEWEST}
      onClick={() => onPick(step(value, by, auto))}
    >
      {by > 0 ? <Plus /> : <Minus />}
    </button>
  );
  return (
    <div className="stepper">
      {button(-1)}
      <span className="n" aria-label="Chats at once">
        {value === "auto" ? "Auto" : value}
      </span>
      {button(1)}
    </div>
  );
}

/**
 * Chats at once as you step it: your last pick shows until the daemon reads it back (quick clicks keep every
 * step), or until it says no to that pick.
 */
function useHeldRuns(saved: MaxRuns | undefined) {
  const [held, setHeld] = useState<MaxRuns | null>(null);
  useEffect(() => {
    if (held !== null && saved === held) setHeld(null);
  }, [saved, held]);
  /** Shows `n` while `call` goes; a refusal lets go of it (unless a newer pick came since). */
  const hold = (n: MaxRuns, call: Promise<unknown>) => {
    setHeld(n);
    call.catch(() => setHeld((h) => (h === n ? null : h)));
  };
  return [held ?? saved, hold] as const;
}

/** Settings → General: how many chats work at once (new chats start on Auto; the composer's access icon switches it). */
export function General({ client, data }: { client: IonClient; data: SettingsData }) {
  const [error, run] = useCallError();
  const s = data.settings;
  const [maxRuns, hold] = useHeldRuns(s?.maxRuns);
  if (!s || maxRuns === undefined) return null;
  return (
    <div>
      <h4>Chats</h4>
      <div className="group">
        <Row label="Chats at once">
          <ChatsAtOnce
            value={maxRuns}
            auto={s.autoRuns}
            onPick={(n) => {
              const call = client.call("settings.set", { patch: { maxRuns: n } });
              hold(n, call);
              run(call, data.reload);
            }}
          />
        </Row>
        {error && <div className="perr">{error}</div>}
      </div>
    </div>
  );
}
