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
import { stripControl } from "@ion/schema";
import { memo, useEffect, useState } from "react";
import { type Step, type ToolStep, type Work, workSeconds } from "./steps.js";

/** "2m 04s", "45s". */
export function duration(seconds: number): string {
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

/** ion's own tools (its MCP server's), in words. */
const ION_TOOLS: Record<string, string> = {
  projects: "Projects",
  search_chats: "Search chats",
  chat_history: "Chat history",
  open_needs: "Open needs",
  memory_list: "Memory",
  memory_write: "Remember",
  decisions: "Decisions",
  set_profile: "Suggest profile",
  start_thread: "Start thread",
  ask: "Ask",
  report_outcome: "Report outcome",
};

/**
 * A step's name as shown: without its MCP server's prefix (`mcp__<server>__`, or ACP's `ion__` for ion's own), and
 * ion's own tools in words.
 */
export function stepName(raw: string): string {
  const name = stripControl(raw);
  const ion = /^(?:mcp__ion__|ion__)(.+)$/.exec(name)?.[1];
  if (ion) return ION_TOOLS[ion] ?? ion;
  return name.replace(/^mcp__.+?__(?=[^_])/, "").trim() || "Tool";
}

/** A step's name and summary as shown. The name alone is mapped to words: the summary is free text. */
function stepText(s: ToolStep): { name: string; summary: string } {
  return { name: stepName(s.name), summary: stepSummary(s) };
}

/** A step's summary as shown: none when it only repeats the tool's name. */
function stepSummary(s: ToolStep): string {
  const summary = stripControl(s.summary).trim();
  const bare = s.name.replace(/^(?:mcp__.+?__|ion__)(?=[^_])/, "");
  const same = [s.name, bare, stepName(s.name)].some((n) => n.toLowerCase() === summary.toLowerCase());
  return same ? "" : summary;
}

/** Ticks once a second while `live`, so a live run's time moves. */
export function useNow(live: boolean): number {
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
  const { name, summary } = stepText(s);
  const Icon = s.ok === false ? CircleAlert : (ICONS[s.toolKind] ?? Wrench);
  let state = s.ok === false ? "err" : "ok";
  if (running) state = "run";
  return (
    <div className={`ws w-${state}`} onClick={() => setOpen(!open)}>
      <Icon />
      <div className="wl">
        <b className={running ? "now" : undefined}>{name}</b>
        {summary && (
          <>
            {" "}
            <code>{summary}</code>
          </>
        )}
        {open && (s.input || s.output) && (
          <div className="wg">
            {s.input && <pre>{stripControl(s.input)}</pre>}
            {s.output && <pre>{stripControl(s.output)}</pre>}
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
        <p>{stripControl(s.text)}</p>
      </div>
      <span />
    </div>
  );
});

/** The step a live run is on, for its header. */
export const current = (w: Work) => {
  const last = w.steps.at(-1);
  if (last?.kind !== "tool") return "Thinking";
  const { name, summary } = stepText(last);
  return summary ? `${name} ${summary}` : name;
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
            <span className="now">{current(w)}</span>
            {/* Under a second, no time: "0s" says nothing. */}
            {workSeconds(w, now) > 0 && <span className="wn">· {duration(workSeconds(w, now))}</span>}
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
