import type { IonClient } from "@ion/client/browser";
import { CircleCheck, CircleX, RotateCw } from "@ion/design-system";
import {
  type AgentCheckRecord,
  type AgentCheckRow,
  type AgentChecksInfo,
  checkLines,
  checksFailed,
} from "@ion/schema";
import { useEffect, useState } from "react";
import { useCallError } from "../callError.js";
import { Switch } from "./Switch.js";

const NAME = "Check the agents each night";

/** The last checks of the agents that failed (all of them when none did): each check, and why one failed. */
function Details({ last }: { last: AgentCheckRecord[] }) {
  const bad = last.filter((r) => checksFailed(r) > 0);
  return (
    <>
      {(bad.length ? bad : last).map((r) => (
        <div key={r.agent} className="srow">
          <div className="g">
            {r.label}
            {r.checks.map((c) => (
              <div key={c.name} className="s chk">
                {c.ok ? <CircleCheck aria-label="Passed" /> : <CircleX className="bad" aria-label="Failed" />}
                {c.note ? `${c.name} · ${c.note}` : c.name}
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

/** An agent in the nightly check: what a night costs it, or why it's left out; a pick for one that isn't free. */
function AgentLine({ a, onPick }: { a: AgentCheckRow; onPick: (on: boolean) => void }) {
  const pickable = a.why === "Only if you pick it" || a.picked;
  const note = a.included || pickable ? a.cost : a.why;
  return (
    <div className="srow">
      <div className="g s">{`${a.label} · ${note}`}</div>
      {pickable && <Switch label={`${a.label}: check each night`} on={a.picked} onPick={onPick} />}
    </div>
  );
}

/** The last checks in a line each, which opens what failed; while checking, says so. */
function Result(p: {
  last: AgentCheckRecord[];
  busy: boolean;
  open: boolean;
  onOpen: (open: boolean) => void;
}) {
  if (p.busy)
    return (
      <div className="s chk">
        <i className="spin" />
        Checking
      </div>
    );
  return (
    <>
      {checkLines(p.last, new Date()).map((line) => (
        <div key={line} className="s">
          <button className="lnk" type="button" aria-expanded={p.open} onClick={() => p.onOpen(!p.open)}>
            {line}
          </button>
        </div>
      ))}
    </>
  );
}

type Change = { nightly?: boolean; pick?: Record<string, boolean> };

/** The check with a change of yours, before the daemon says (tour, 2026-11-28: the switch waited seconds). */
function changed(i: AgentChecksInfo, c: Change): AgentChecksInfo {
  const pick = c.pick ?? {};
  return {
    ...i,
    nightly: c.nightly ?? i.nightly,
    agents: i.agents.map((a) => (a.agent in pick ? { ...a, picked: pick[a.agent]! } : a)),
  };
}

/** The nightly check as the daemon has it, saving a change and checking now. */
function useChecks(client: IonClient) {
  const [info, setInfo] = useState<AgentChecksInfo | null>(null);
  const [going, setGoing] = useState(false);
  const [error, run] = useCallError();
  // An older ion without the check: nothing to show.
  useEffect(
    () =>
      void client.call("agents.checks", {}).then(
        (i) => i?.agents && setInfo(i),
        () => {},
      ),
    [client],
  );
  // Shown at once (the daemon reads each agent's cost again, which takes a moment), then as the daemon has it.
  const save = (args: Change) => {
    setInfo((i) => i && changed(i, args));
    run(client.call("agents.checks", args), setInfo);
  };
  const now = () => {
    setGoing(true);
    run(
      client.call("agents.check", {}).finally(() => setGoing(false)),
      setInfo,
    );
  };
  return { info, busy: going || !!info?.running, error, save, now };
}

/**
 * "Check the agents each night" (Plan 21 Task 5): one quiet line with its switch, off until you turn it on. On: each
 * agent with what a night costs it (one that isn't free, Claude Code too, only once you pick it; one you avoid or
 * that's limited says so). Check now, on or off. The last checks in a line ("Checked last night: all fine", or one per agent
 * that failed), which opens what failed.
 */
export function AgentChecks({ client }: { client: IonClient }) {
  const { info, busy, error, save, now } = useChecks(client);
  const [open, setOpen] = useState(false);
  if (!info) return null;
  return (
    <div className="group">
      <div className="srow">
        <div className="g">
          {NAME}
          <Result last={info.last} busy={busy} open={open} onOpen={setOpen} />
        </div>
        <button
          className="ib"
          type="button"
          title="Check now"
          aria-label="Check now"
          disabled={busy}
          onClick={now}
        >
          <RotateCw />
        </button>
        <Switch
          label={NAME}
          title={`In quiet hours (${info.window})`}
          on={info.nightly}
          onPick={(on) => save({ nightly: on })}
        />
      </div>
      {open && !busy && <Details last={info.last} />}
      {info.nightly &&
        info.agents.map((a) => (
          <AgentLine key={a.agent} a={a} onPick={(on) => save({ pick: { [a.agent]: on } })} />
        ))}
      {error && <div className="perr">{error}</div>}
    </div>
  );
}
