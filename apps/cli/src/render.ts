import { EV, type IonEvent, type NeedInfo } from "@ion/schema";
import { clean, detailLines, text } from "./sanitize.js";

const HARNESS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
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

export type RunEnd = { status: string; code: number };
/**
 * `soon`: the run ended, but ion may still ask what to do next (a limit): end unless its question comes. `follow`:
 * ion went on on another agent: follow the run it started.
 */
type Rendered = { text: string; end?: RunEnd; soon?: RunEnd; follow?: true };

/** What the renderer remembers between events of one run. */
type State = {
  midLine: boolean;
  startedAt: number;
  cost: number | null;
  lastError: string | null;
  asks: Map<string, string>;
  /** The run failed on a limit: ion's question about it ends the run's output. */
  limited?: RunEnd;
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
  // A limit isn't a failure: ion asks, waits or goes on (final review, 2026-11-23).
  if (s.limited) return { text: line(s, `· ${s.lastError ?? "Limit reached"}`), soon: s.limited };
  return { text: line(s, `Failed: ${s.lastError ?? "the run stopped"}`), end: { status, code: 1 } };
}

/** ion's line after a limit: it went on (follow that run), waits (ends well: the chat goes on by itself), or not. */
function handoffLine(s: State, d: D): Rendered {
  if (d.kind === "routed") return quiet;
  const text = line(s, `· ${clean(d.text)}`);
  if (d.kind === "continued") return { text, follow: true };
  if (d.kind === "waiting") return { text, end: { status: "waiting", code: 0 } };
  if (d.kind === "failed") return { text, end: { status: "failed", code: 1 } };
  return { text };
}

const HANDLERS: Partial<Record<string, (s: State, d: D, e: IonEvent) => Rendered>> = {
  [EV.runStarted]: (s, d, e) => {
    if (s.startedAt) return quiet; // a retry: same run, already introduced
    s.startedAt = Date.parse(e.ts);
    const label = HARNESS[String(d.harness)] ?? String(d.harness);
    return { text: line(s, [label, d.authMethod, d.model].filter(Boolean).map(clean).join(" · ")) };
  },
  [EV.messageDelta]: (s, d) => {
    const streamed = text(d.text);
    s.midLine = !streamed.endsWith("\n");
    return { text: streamed };
  },
  [EV.toolStarted]: (s, d) =>
    d.kind === "edit"
      ? quiet
      : { text: line(s, `· ${VERB[String(d.kind)] ?? "Used"} ${clean(d.summary || d.name)}`) },
  [EV.fileChanged]: (s, d) => {
    const counts = typeof d.added === "number" ? ` (+${d.added} −${d.removed ?? 0})` : "";
    return { text: line(s, `· Edited ${clean(d.path)}${counts}`) };
  },
  [EV.approvalRequested]: (s, d) => {
    s.asks.set(String(d.requestId), clean(d.summary));
    return quiet;
  },
  [EV.approvalResolved]: (s, d) => {
    const what = d.summary ? clean(d.summary) : (s.asks.get(String(d.requestId)) ?? "a tool");
    // Auto: a denial says why. Allows (most actions) stay quiet; they're recorded all the same.
    if (d.by === "ion")
      return d.decision === "deny"
        ? { text: line(s, `· Denied by ion: ${what} — ${clean(d.reason)}`) }
        : quiet;
    return d.decision === "deny" ? { text: line(s, `· Asked to use ${what} — denied (${d.by})`) } : quiet;
  },
  [EV.needRaised]: (s, d) => {
    if (d.kind !== "ask" || !Array.isArray(d.choices))
      return { text: line(s, `· Waiting on you: ${clean(d.summary)}`) + detailLines(d.detail) };
    const choices = (d.choices as { label: unknown; consequence: unknown; recommended?: unknown }[]).map(
      (c, i) =>
        `  ${i + 1}. ${clean(c.label)}${c.recommended === true ? " (recommended)" : ""} — ${clean(c.consequence)}\n`,
    );
    const ask = line(s, `· Asked you: ${clean(d.summary)}`);
    return {
      text: `${ask}${choices.join("")}  Answer: ion answer ${clean(d.needId)} <number, or your own words>\n`,
      ...(s.limited ? { end: s.limited } : {}),
    };
  },
  [EV.needResolved]: (s, d) =>
    d.decision === "answered" ? { text: line(s, `· You chose: ${clean(d.choice)}`) } : quiet,
  [EV.decisionRecorded]: (s, d) => {
    if (d.by !== "ion") return quiet;
    const on = new Date(String(d.fromDecidedAt)).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
    return { text: line(s, `· Answered by ion from your decision on ${on}: ${clean(d.choice)}`) };
  },
  [EV.runRetrying]: (s, d) => {
    const secs = Math.ceil(Number(d.delayS) || 0);
    const when = secs > 0 ? `in ${secs}s` : "now";
    const effort = d.effort ? ` at ${clean(d.effort)} effort` : "";
    return { text: line(s, `· Retrying ${when}${effort} (${clean(d.reason).toLowerCase()})`) };
  },
  [EV.usageReported]: (s, d) => {
    if (typeof d.costUsd === "number") s.cost = d.costUsd;
    return quiet;
  },
  [EV.error]: (s, d) => {
    s.lastError = clean(d.message);
    if (d.limit) s.limited = { status: "failed", code: 1 };
    return quiet;
  },
  [EV.runFinished]: (s, d, e) => endLine(s, String(d.status), e.ts),
  [EV.chatHandoff]: handoffLine,
};

/** Turns one run's events into terminal text. */
export function createRenderer(): (e: IonEvent) => Rendered {
  const s: State = { midLine: false, startedAt: 0, cost: null, lastError: null, asks: new Map() };
  return (e) => HANDLERS[e.type]?.(s, e.data as D, e) ?? quiet;
}

/** A question or need as `ion needs` prints it: id, project and summary; the ion's note; the detail; the choices. */
export function needText(x: NeedInfo): string {
  const choices = (x.choices ?? []).map(
    (ch, i) =>
      `\n  ${i + 1}. ${clean(ch.label)}${ch.recommended ? " (recommended)" : ""} — ${clean(ch.consequence)}`,
  );
  const note = x.via ? `\n  ${clean(x.via.note)}` : "";
  return (
    [x.needId, x.projectId ?? "-", x.summary].map(clean).join("  ") +
    note +
    `\n${detailLines(x.detail)}`.trimEnd() +
    choices.join("")
  );
}
