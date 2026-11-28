import type { IonClient } from "@ion/client/browser";
import { BellRing, Inbox, type LucideIcon, Moon, Pin, Star, Sunrise } from "@ion/design-system";
import type { NotifyLevel, SettingsInfo, SettingsPatch } from "@ion/schema";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { why } from "../callError.js";
import type { SettingsData } from "./data.js";
import { Switch } from "./Switch.js";
import { projectName } from "../projectName.js";

type Notifs = NonNullable<SettingsPatch["notifications"]>;

/** How loud each kind of thing is: fixed, shown so you know what to expect. */
const LOUD: [LucideIcon, string, string][] = [
  [BellRing, "Urgent", "Notify and pin"],
  [Pin, "Needs you", "Pin"],
  [Inbox, "Updates", "Briefing"],
];

const LEVELS: [NotifyLevel, string][] = [
  ["all", "All"],
  ["needs", "Needs me"],
  ["digest", "Digest"],
  ["muted", "Muted"],
];

function Line({ icon: Icon, label, children }: { icon?: LucideIcon; label: ReactNode; children: ReactNode }) {
  return (
    <div className="srow">
      {Icon && <Icon className="nic" />}
      <div className="g">{label}</div>
      {children}
    </div>
  );
}

/**
 * A time, typed as HH:MM: saved once, when you leave the box or press Enter, and only if it changed. While you're
 * in the box, what you type stays; the saved time comes back only when you're not.
 */
function Time(p: { label: string; value: string; onPick: (at: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState(p.value);
  const inBox = useRef(false);
  const sent = useRef(p.value);
  const saved = useRef(p.value);
  saved.current = p.value;
  useEffect(() => {
    sent.current = p.value;
    if (!inBox.current) setDraft(p.value);
  }, [p.value]);
  const save = () => {
    if (!draft || draft === sent.current) return;
    sent.current = draft;
    void p.onPick(draft).then((ok) => {
      if (ok) return;
      // Refused: the time you tried can be tried again; out of the box, the saved time shows again.
      sent.current = saved.current;
      if (!inBox.current) setDraft(saved.current);
    });
  };
  return (
    <input
      className="fin time"
      type="time"
      aria-label={p.label}
      value={draft}
      onFocus={() => {
        inBox.current = true;
      }}
      onBlur={() => {
        inBox.current = false;
        save();
      }}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && save()}
    />
  );
}

type Part = { client: IonClient; data: SettingsData; n: SettingsInfo["notifications"] };

/** Saves a change to notifications: [the daemon's reason when it said no, save]. */
function useSave({ client, data }: Part): [string | null, (p: Notifs) => Promise<boolean>] {
  const [error, setError] = useState<string | null>(null);
  return [
    error,
    (notifications) =>
      client.call("settings.set", { patch: { notifications } }).then(
        () => {
          setError(null);
          data.reload();
          return true;
        },
        (e: unknown) => {
          setError(why(e));
          return false;
        },
      ),
  ];
}

/** The daily briefing and quiet hours: each a time (or two) and a switch. */
function Timing(part: Part) {
  const [error, save] = useSave(part);
  const n = part.n;
  return (
    <div>
      <h4>Timing</h4>
      <div className="group">
        <Line icon={Sunrise} label="Daily briefing">
          <div className="acts2">
            <Time label="Briefing time" value={n.briefing.at} onPick={(at) => save({ briefing: { at } })} />
            <Switch label="Daily briefing" on={n.briefing.on} onPick={(on) => save({ briefing: { on } })} />
          </div>
        </Line>
        <Line icon={Moon} label="Quiet hours">
          <div className="acts2">
            <Time label="Quiet from" value={n.quiet.from} onPick={(from) => save({ quiet: { from } })} />
            <span className="dash">–</span>
            <Time label="Quiet until" value={n.quiet.to} onPick={(to) => save({ quiet: { to } })} />
            <Switch label="Quiet hours" on={n.quiet.on} onPick={(on) => save({ quiet: { on } })} />
          </div>
        </Line>
        {error && <div className="perr">{error}</div>}
      </div>
    </div>
  );
}

/** Each project's level: All, Needs me (the default), Digest or Muted. */
function PerProject(part: Part) {
  const [error, save] = useSave(part);
  const { data, n } = part;
  if (!data.projects.length) return null;
  return (
    <div>
      <h4>Per project</h4>
      <div className="group">
        {data.projects.map((p) => {
          const name = projectName(p.id, p.name);
          const level = n.projects[p.id] ?? "needs";
          const label = (
            <>
              {name}
              {p.starred && <Star className="stari sm" />}
            </>
          );
          return (
            <Line key={p.id} label={label}>
              <span className="seg sm" role="group" aria-label={name}>
                {LEVELS.map(([id, l]) => (
                  <button
                    key={id}
                    type="button"
                    className={level === id ? "on" : ""}
                    onClick={() => save({ projects: { [p.id]: id } })}
                  >
                    {l}
                  </button>
                ))}
              </span>
            </Line>
          );
        })}
        {error && <div className="perr">{error}</div>}
      </div>
    </div>
  );
}

/** Settings → Notifications, as the lab's: how loud each kind is, when, and each project's level. */
export function Notifications({ client, data }: { client: IonClient; data: SettingsData }) {
  const n = data.settings?.notifications;
  if (!n) return null;
  return (
    <>
      <div>
        <h4>How loud</h4>
        <div className="group">
          {LOUD.map(([icon, kind, what]) => (
            <Line key={kind} icon={icon} label={kind}>
              <span className="chip">{what}</span>
            </Line>
          ))}
        </div>
      </div>
      <Timing client={client} data={data} n={n} />
      <PerProject client={client} data={data} n={n} />
    </>
  );
}
