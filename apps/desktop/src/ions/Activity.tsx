import type { IonClient } from "@ion/client/browser";
import {
  Activity as ActivityIcon,
  CircleCheck,
  CirclePause,
  CirclePlay,
  CircleX,
  Pause,
  Play,
  SkipForward,
  Undo2,
} from "@ion/design-system";
import {
  type ActivityInfo,
  EV,
  type IonInfo,
  type RecentRun,
  timeLabel,
  type UpcomingRun,
} from "@ion/schema";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { effortLabel } from "../chats/BrainPopover.js";
import { IonAvatar } from "./IonChat.js";

/** What changes Activity: a routine running, a thread starting or ending. */
const ACTIVITY_CHANGE = new Set<string>([EV.routineRan, EV.chatCreated, EV.runStarted, EV.runFinished]);
const MINUTE = 60_000;

/** Activity, kept live: read again when something it shows changes, and each minute (times move on). */
export function useActivity(client: IonClient): [ActivityInfo | null, () => void] {
  const [a, setA] = useState<ActivityInfo | null>(null);
  const read = useCallback(() => void client.call("activity.list", {}).then(setA, () => {}), [client]);
  useEffect(() => {
    read();
    const timer = setInterval(read, MINUTE);
    let stop: (() => void) | undefined;
    let gone = false;
    void client
      .subscribe({ fromNow: true }, (e) => {
        if (!gone && ACTIVITY_CHANGE.has(e.type)) read();
      })
      .then(
        (s) => {
          if (gone) s();
          else stop = s;
        },
        () => {},
      );
    return () => {
      gone = true;
      clearInterval(timer);
      stop?.();
    };
  }, [client, read]);
  return [a, read];
}

/** The Activity row's line, as the lab's nextLine(): what runs next, or why nothing does. */
export function nextLine(a: ActivityInfo | null): string {
  if (a?.paused) return "All routines paused";
  const u = a?.upcoming.find((x) => x.next);
  return u?.next ? `Next: ${u.ion} · ${timeLabel(new Date(u.next), new Date())}` : "No routines scheduled";
}

/** The lab's Activity row, atop the Ions panel. */
export function ActivityRow(p: { activity: ActivityInfo | null; on: boolean; onOpen: () => void }) {
  return (
    <button className={`ir actrow${p.on ? " on" : ""}`} type="button" onClick={p.onOpen}>
      <span className="aico">
        <ActivityIcon />
      </span>
      <span>
        <b>Activity</b>
        <span>{nextLine(p.activity)}</span>
      </span>
    </button>
  );
}

type Act = (cmd: "routine.update" | "routine.run", u: UpcomingRun, extra?: object) => void;

/** A routine's next run: its ion, name, effort and time, then run now, skip next and pause. */
function UpcomingRow({ u, ion, paused, act }: { u: UpcomingRun; ion?: IonInfo; paused: boolean; act: Act }) {
  const off = !u.on || paused;
  let when = u.next ? timeLabel(new Date(u.next), new Date()) : "";
  if (u.skipped) when = "Skipped once";
  return (
    <div className={`arow${off ? " off" : ""}`}>
      {ion ? <IonAvatar ion={ion} /> : <span />}
      <span className="g">
        <b>{u.name}</b>
        <small>{[u.ion, u.effort ? effortLabel(u.effort) : null].filter(Boolean).join(" · ")}</small>
      </span>
      <span className="when">
        {off ? (
          <>
            <Pause />
            Paused
          </>
        ) : (
          when
        )}
      </span>
      <span className="ra">
        <Icon label="Run now" disabled={paused} onClick={() => act("routine.run", u)}>
          <Play />
        </Icon>
        <Icon
          label={u.skipped ? "Undo skip" : "Skip next run"}
          disabled={off}
          onClick={() => act("routine.update", u, { skip: !u.skipped })}
        >
          {u.skipped ? <Undo2 /> : <SkipForward />}
        </Icon>
        <Icon label={u.on ? "Pause" : "Resume"} onClick={() => act("routine.update", u, { on: !u.on })}>
          {u.on ? <Pause /> : <CirclePlay />}
        </Icon>
      </span>
    </div>
  );
}

function Icon(p: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      className="ib"
      type="button"
      title={p.label}
      aria-label={p.label}
      disabled={p.disabled}
      onClick={p.onClick}
    >
      {p.children}
    </button>
  );
}

const ENDED: Record<string, { label: string; ok: boolean }> = {
  done: { label: "Done", ok: true },
  failed: { label: "Failed", ok: false },
  interrupted: { label: "Stopped", ok: false },
  capped: { label: "Hit its limit", ok: false },
};

/** How a run went: an icon (named on hover) once it ended; "Running" shimmers while it goes. */
function Outcome({ status }: { status: string }) {
  const e = ENDED[status];
  if (!e) return <span className="now">Running</span>;
  return (
    <span title={e.label} aria-label={e.label} role="img">
      {e.ok ? <CircleCheck className="ok" /> : <CircleX className="no" />}
    </span>
  );
}

function RecentRow({ r, ion, onOpen }: { r: RecentRun; ion?: IonInfo; onOpen: () => void }) {
  const at = new Date(r.at);
  return (
    <button className="arow" type="button" onClick={onOpen}>
      {ion ? <IonAvatar ion={ion} /> : <span />}
      <span className="g">
        <b>{r.title}</b>
        <small>{[r.ion, r.routine].filter(Boolean).join(" · ")}</small>
      </span>
      <span className="out">
        <Outcome status={r.status} />
      </span>
      <span className="cost">{r.costUsd ? `$${r.costUsd.toFixed(2)}` : ""}</span>
      <span className="when">{`${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}`}</span>
    </button>
  );
}

type PageProps = {
  client: IonClient;
  activity: ActivityInfo | null;
  ions: IonInfo[];
  reload: () => void;
  onOpenChat: (chatId: string) => void;
};

function Recent(p: PageProps & { day: "Today" | "Yesterday"; runs: RecentRun[] }) {
  const ionOf = (id: string) => p.ions.find((x) => x.ionId === id);
  if (!p.runs.length) return null;
  return (
    <>
      <div className="ag">{p.day}</div>
      <div className="group">
        {p.runs.map((r) => (
          <RecentRow key={r.runId} r={r} ion={ionOf(r.projectId)} onOpen={() => p.onOpenChat(r.chatId)} />
        ))}
      </div>
    </>
  );
}

function Upcoming(p: PageProps & { paused: boolean }) {
  const act: Act = (cmd, u, extra = {}) =>
    void p.client
      .call(cmd, { projectId: u.projectId, routineId: u.routineId, ...extra })
      .then(p.reload, () => {});
  const list = p.activity?.upcoming ?? [];
  return (
    <>
      <div className="ag">Upcoming</div>
      <div className="group">
        {list.map((u) => (
          <UpcomingRow
            key={`${u.projectId}/${u.routineId}`}
            u={u}
            ion={p.ions.find((x) => x.ionId === u.projectId)}
            paused={p.paused}
            act={act}
          />
        ))}
        {!list.length && (
          <div className="srow">
            <div className="g s">No routines yet</div>
          </div>
        )}
      </div>
    </>
  );
}

/** The lab's Activity page: pause all, what's next, and what ion's threads did today and yesterday. */
export function ActivityPage(p: PageProps) {
  const paused = p.activity?.paused ?? false;
  const pause = (on: boolean) =>
    void p.client.call("routines.pause", { paused: on }).then(p.reload, () => {});
  return (
    <section className="ichat">
      <header className="head" data-tauri-drag-region>
        <span className="aico sm">
          <ActivityIcon />
        </span>
        <span className="title">Activity</span>
        <span className="sp" />
        <span className="pall">
          Pause all
          <button
            type="button"
            className={`sw${paused ? " on" : ""}`}
            role="switch"
            aria-checked={paused}
            aria-label="Pause all"
            onClick={() => pause(!paused)}
          />
        </span>
      </header>
      <div className="bubbles">
        <div className="acol">
          {paused && (
            <div className="pban">
              <CirclePause />
              <span className="g">All routines are paused.</span>
              <button className="btn" type="button" onClick={() => pause(false)}>
                Resume all
              </button>
            </div>
          )}
          <Upcoming {...p} paused={paused} />
          <Recent {...p} day="Today" runs={p.activity?.today ?? []} />
          <Recent {...p} day="Yesterday" runs={p.activity?.yesterday ?? []} />
        </div>
      </div>
    </section>
  );
}
