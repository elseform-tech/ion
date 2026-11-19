import type { IonClient } from "@ion/client/browser";
import { Plus, Trash2 } from "@ion/design-system";
import {
  type EffortLevel,
  type ProjectInfo,
  type RoutineInfo,
  timeLabel,
  type UpcomingRun,
  WEEKDAYS,
  whenLabel,
} from "@ion/schema";
import { useCallback, useEffect, useState } from "react";
import { Bars, effortLabel } from "../chats/BrainPopover.js";

const EFFORT_CYCLE: ("" | EffortLevel)[] = ["", "low", "medium", "high", "max"];

type Call = (cmd: "routine.update" | "routine.remove", args: object) => void;

/** One routine: its name, when, what it does; its effort (click to change), next run, switch and remove. */
function RoutineRow({ r, next, call }: { r: RoutineInfo; next: UpcomingRun | undefined; call: Call }) {
  const ids = { routineId: r.id };
  const effort = r.effort ?? "";
  const bump = EFFORT_CYCLE[(EFFORT_CYCLE.indexOf(effort) + 1) % EFFORT_CYCLE.length]!;
  const at = next?.next ? `Next: ${timeLabel(new Date(next.next), new Date())}` : "Paused";
  return (
    <div className="srow">
      <div className="g">
        {r.name}
        <div className="s">{whenLabel(r.when)}</div>
        <div className="rin">{r.text}</div>
      </div>
      <button
        className="val"
        type="button"
        title="Effort (click to change)"
        aria-label={`Effort: ${effortLabel(effort)}`}
        onClick={() => call("routine.update", { ...ids, effort: bump || null })}
      >
        <Bars effort={effort} />
        {effortLabel(effort)}
      </button>
      <span className="nx">{at}</span>
      <button
        type="button"
        className={`sw${r.on ? " on" : ""}`}
        role="switch"
        aria-checked={r.on}
        aria-label={r.name}
        onClick={() => call("routine.update", { ...ids, on: !r.on })}
      />
      <button
        className="ib"
        type="button"
        title={`Remove ${r.name}`}
        aria-label={`Remove ${r.name}`}
        onClick={() => call("routine.remove", ids)}
      >
        <Trash2 />
      </button>
    </div>
  );
}

type Kind = "daily" | "weekdays" | "weekly" | "hours";
type Pick = { kind: Kind; day: string; time: string; every: string };
const KINDS: [Kind, string][] = [
  ["daily", "Daily"],
  ["weekdays", "Weekdays"],
  ["weekly", "Weekly"],
  ["hours", "Hourly"],
];
const EVERY = ["1", "2", "3", "4", "6", "8", "12"];
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** The schedule a pick makes: "daily 09:00", "fri 09:00", "every 4h". */
function whenOf(p: Pick): string {
  if (p.kind === "hours") return `every ${p.every}h`;
  return `${p.kind === "weekly" ? p.day : p.kind} ${p.time || "09:00"}`;
}

function Seg<T extends string>(p: { items: [T, string][]; value: T; onPick: (v: T) => void }) {
  return (
    <span className="seg sm">
      {p.items.map(([id, label]) => (
        <button key={id} type="button" className={p.value === id ? "on" : ""} onClick={() => p.onPick(id)}>
          {label}
        </button>
      ))}
    </span>
  );
}

/** When it runs, picked: how often, then the day, the time, or every how many hours. */
function WhenPicker({ pick, set }: { pick: Pick; set: (p: Pick) => void }) {
  const days = [...WEEKDAYS.slice(1), WEEKDAYS[0]].map((d): [string, string] => [d, cap(d)]);
  return (
    <div className="wpick">
      <Seg items={KINDS} value={pick.kind} onPick={(kind) => set({ ...pick, kind })} />
      {pick.kind === "weekly" && (
        <Seg items={days} value={pick.day} onPick={(day) => set({ ...pick, day })} />
      )}
      {pick.kind === "hours" ? (
        <select
          className="fin"
          aria-label="Every"
          value={pick.every}
          onChange={(e) => set({ ...pick, every: e.target.value })}
        >
          {EVERY.map((n) => (
            <option key={n} value={n}>
              {n === "1" ? "Every hour" : `Every ${n} hours`}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="fin"
          type="time"
          aria-label="Time"
          value={pick.time}
          onChange={(e) => set({ ...pick, time: e.target.value })}
        />
      )}
    </div>
  );
}

const FRESH: Pick = { kind: "daily", day: "mon", time: "09:00", every: "4" };

/** Add routine: a name, when (picked), and what to do. */
function AddRoutine(p: { client: IonClient; projectId: string; onAdded: () => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [pick, setPick] = useState(FRESH);
  const [error, setError] = useState<string | null>(null);
  const add = () =>
    void p.client
      .call("routine.add", {
        projectId: p.projectId,
        name: name.trim(),
        when: whenOf(pick),
        text: text.trim(),
      })
      .then(p.onAdded, (e: Error) => setError(e.message));
  return (
    <div className="srow stack radd">
      <input
        className="fin"
        aria-label="Name"
        placeholder="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <WhenPicker pick={pick} set={setPick} />
      <textarea
        className="fin"
        aria-label="What to do"
        placeholder="What to do"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {error && <div className="perr">{error}</div>}
      <div className="acts2">
        <button className="btn pri" type="button" disabled={!name.trim() || !text.trim()} onClick={add}>
          Add
        </button>
        <button className="btn" type="button" onClick={p.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** What this project's ion does on a schedule, and when each runs next. */
function useUpcoming(client: IonClient, projectId: string): [UpcomingRun[], () => void] {
  const [up, setUp] = useState<UpcomingRun[]>([]);
  const read = useCallback(
    () =>
      void client.call("activity.list", {}).then(
        (a) => setUp(a.upcoming.filter((u) => u.projectId === projectId)),
        () => {},
      ),
    [client, projectId],
  );
  useEffect(read, [read]);
  return [up, read];
}

/** The lab's Routines group on an ion's page: a row per routine, then Add routine. */
export function Routines(p: { client: IonClient; project: ProjectInfo; onChanged: () => void }) {
  const [up, readUp] = useUpcoming(p.client, p.project.id);
  const [adding, setAdding] = useState(false);
  const changed = () => {
    p.onChanged();
    readUp();
  };
  const call: Call = (cmd, args) =>
    void p.client.call(cmd, { projectId: p.project.id, ...args } as never).then(changed, () => {});
  const list = p.project.routines ?? [];
  return (
    <div>
      <h4>Routines</h4>
      <div className="group">
        {list.map((r) => (
          <RoutineRow key={r.id} r={r} next={up.find((u) => u.routineId === r.id)} call={call} />
        ))}
        {adding ? (
          <AddRoutine
            client={p.client}
            projectId={p.project.id}
            onAdded={() => {
              setAdding(false);
              changed();
            }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <button className="srow radd-btn" type="button" onClick={() => setAdding(true)}>
            <Plus />
            Add routine
          </button>
        )}
      </div>
    </div>
  );
}
