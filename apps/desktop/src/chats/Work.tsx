import {
  Brain,
  ChevronRight,
  CircleAlert,
  FilePen,
  FileText,
  Globe,
  type LucideIcon,
  Plug,
  Search,
  Sparkles,
  SquareTerminal,
  Wrench,
} from "@ion/design-system";
import { memo, useEffect, useState } from "react";
import { type Step, type ToolStep, type Work, workSeconds } from "./steps.js";

/** "2m 04s", "45s". */
function duration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

/** "Worked for 2m 04s"; under a second, just "Worked". */
const doneLabel = (verb: string, secs: number) => (secs < 1 ? verb : `${verb} for ${duration(secs)}`);

/** The lab's icon for each kind of tool. */
const ICONS: Record<string, LucideIcon> = {
  read: FileText,
  edit: FilePen,
  command: SquareTerminal,
  search: Search,
  web: Globe,
  mcp: Plug,
};

/** Ticks once a second while `live`, so a live run's time moves. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  return now;
}

/** A tool step: its icon (or a spinner while it runs), name and argument; opens to its input and output. */
const ToolRow = memo(function ToolRow({ s, live }: { s: ToolStep; live: boolean }) {
  const [open, setOpen] = useState(false);
  const running = live && s.ok === undefined;
  const Icon = s.ok === false ? CircleAlert : (ICONS[s.toolKind] ?? Wrench);
  let state = s.ok === false ? "err" : "ok";
  if (running) state = "run";
  return (
    <div className={`ws w-${state}`} onClick={() => setOpen(!open)}>
      {running ? <i className="spin" /> : <Icon />}
      <div className="wl">
        <b>{s.name}</b> <code>{s.summary}</code>
        {open && (s.input || s.output) && (
          <div className="wg">
            {s.input && <pre>{s.input}</pre>}
            {s.output && <pre>{s.output}</pre>}
          </div>
        )}
      </div>
      <span />
    </div>
  );
});

/** A thinking step: "Thought for 4s" and what it thought (clamped; click for all of it). */
const ThinkRow = memo(function ThinkRow({ s }: { s: Extract<Step, { kind: "think" }> }) {
  const [full, setFull] = useState(false);
  const secs = Math.max(1, Math.round((Date.parse(s.to) - Date.parse(s.from)) / 1000));
  return (
    <div className={`ws think${full ? " full" : ""}`} onClick={() => setFull(!full)}>
      <Brain />
      <div className="wl">
        <b>Thought for {duration(secs)}</b>
        <p>{s.text}</p>
      </div>
      <span />
    </div>
  );
});

/** The step a live run is on, for its header. */
const current = (w: Work) => {
  const last = w.steps.at(-1);
  return last?.kind === "tool" ? `${last.name} ${last.summary}` : "Thinking";
};

/**
 * One turn's work, as the lab's `.work`: "Worked for 2m 04s" (or "Thought for" with no tools), closed once done;
 * while live, a spinner, the current step and the time so far.
 */
export const WorkBlock = memo(function WorkBlock({ w }: { w: Work }) {
  const live = !w.ended;
  const [open, setOpen] = useState(false);
  const now = useNow(live);
  const tools = w.steps.some((s) => s.kind === "tool");
  const Head = tools ? Wrench : Sparkles;
  return (
    <div className={`work${open ? " open" : ""}`}>
      <button className="wh" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight className="cv" />
        {live ? (
          <>
            <i className="spin" />
            <span className="now">{current(w)}</span>
            <span className="wn">· {duration(workSeconds(w, now))}</span>
          </>
        ) : (
          <>
            <Head />
            <span>{doneLabel(tools ? "Worked" : "Thought", workSeconds(w))}</span>
          </>
        )}
      </button>
      {open && (
        <div className="wb">
          {w.steps.map((s, i) =>
            s.kind === "tool" ? <ToolRow key={i} s={s} live={live} /> : <ThinkRow key={i} s={s} />,
          )}
        </div>
      )}
    </div>
  );
});
