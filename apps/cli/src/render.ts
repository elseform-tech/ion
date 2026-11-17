import { EV, type IonEvent } from "@ion/schema";

const HARNESS: Record<string, string> = {
  "claude-code": "Claude Code",
  "grok-build": "Grok Build",
  opencode: "opencode",
  fake: "Fake",
};
const VERB: Record<string, string> = {
  read: "Read",
  search: "Searched",
  command: "Ran",
  web: "Fetched",
  mcp: "Used",
  other: "Used",
};

type D = Record<string, unknown>;

// C0/C1 control characters except newline and tab: agents' text must not drive the terminal.
const CONTROL = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]", "g");
const clean = (x: unknown): string => String(x ?? "").replace(CONTROL, "");
export type RunEnd = { status: string; code: number };
type Rendered = { text: string; end?: RunEnd };

/** What the renderer remembers between events of one run. */
type State = {
  midLine: boolean;
  startedAt: number;
  cost: number | null;
  lastError: string | null;
  asks: Map<string, string>;
};

/** A full line, starting on a fresh line if streamed text left one open. */
function line(s: State, text: string): string {
  const pre = s.midLine ? "\n" : "";
  s.midLine = false;
  return `${pre}${text}\n`;
}

const quiet: Rendered = { text: "" };

/** The last line of a run, and the exit code that goes with it. */
function endLine(s: State, status: string, ts: string): Rendered {
  const secs = `${((Date.parse(ts) - s.startedAt) / 1000).toFixed(1)}s`;
  if (status === "done") {
    const parts = ["Done", secs, ...(s.cost === null ? [] : [`$${s.cost.toFixed(4)}`])];
    return { text: line(s, parts.join(" · ")), end: { status, code: 0 } };
  }
  if (status === "interrupted") return { text: line(s, "Stopped"), end: { status, code: 130 } };
  if (status === "capped")
    return { text: line(s, "Stopped: spending cap reached"), end: { status, code: 1 } };
  return { text: line(s, `Failed: ${s.lastError ?? "the run stopped"}`), end: { status, code: 1 } };
}

const HANDLERS: Partial<Record<string, (s: State, d: D, e: IonEvent) => Rendered>> = {
  [EV.runStarted]: (s, d, e) => {
    s.startedAt = Date.parse(e.ts);
    const label = HARNESS[String(d.harness)] ?? String(d.harness);
    return { text: line(s, [label, d.authMethod, d.model].filter(Boolean).map(clean).join(" · ")) };
  },
  [EV.messageDelta]: (s, d) => {
    const text = clean(d.text);
    s.midLine = !text.endsWith("\n");
    return { text };
  },
  [EV.toolStarted]: (s, d) =>
    d.kind === "edit" ? quiet : { text: line(s, `· ${VERB[String(d.kind)] ?? "Used"} ${clean(d.summary)}`) },
  [EV.fileChanged]: (s, d) => {
    const counts = typeof d.added === "number" ? ` (+${d.added} −${d.removed ?? 0})` : "";
    return { text: line(s, `· Edited ${clean(d.path)}${counts}`) };
  },
  [EV.approvalRequested]: (s, d) => {
    s.asks.set(String(d.requestId), clean(d.summary));
    return quiet;
  },
  [EV.approvalResolved]: (s, d) =>
    d.decision === "deny"
      ? { text: line(s, `· Asked to use ${s.asks.get(String(d.requestId)) ?? "a tool"} — denied (${d.by})`) }
      : quiet,
  [EV.usageReported]: (s, d) => {
    if (typeof d.costUsd === "number") s.cost = d.costUsd;
    return quiet;
  },
  [EV.error]: (s, d) => {
    s.lastError = clean(d.message);
    return quiet;
  },
  [EV.runFinished]: (s, d, e) => endLine(s, String(d.status), e.ts),
};

/** Turns one run's events into terminal text. */
export function createRenderer(): (e: IonEvent) => Rendered {
  const s: State = { midLine: false, startedAt: 0, cost: null, lastError: null, asks: new Map() };
  return (e) => HANDLERS[e.type]?.(s, e.data as D, e) ?? quiet;
}
