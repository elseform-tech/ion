import { isAbsolute, relative } from "node:path";
import {
  type AdapterEvent,
  blocksText,
  TOOL_INPUT_MAX,
  TOOL_OUTPUT_MAX,
  toolText,
  usageWindow,
} from "@ion/adapter-kit";
import { EV, type UsageWindow } from "@ion/schema";
import { unwrapShell } from "./gate.js";

type Json = Record<string, unknown>;
type Change = { path?: unknown; kind?: { type?: unknown; move_path?: unknown }; diff?: unknown };
export type TurnError = { message: string; codexErrorInfo?: unknown };

/** What a turn's notifications leave behind: tools started, each edit's files (for its approval), tokens. */
export type CodexState = {
  roots: string[];
  tools: Set<string>;
  edits: Map<string, string[]>;
  /** Each MCP tool call still running, by item id, for the approval Codex asks without naming the call. */
  mcp: Map<string, { server: string; tool: string; arguments: unknown }>;
  usage: { inputTokens: number; outputTokens: number } | null;
  /** Its plan's rate-limit windows, as Codex last said (account/rateLimits); null when it hasn't. */
  windows: UsageWindow[] | null;
  error: TurnError | null;
};

export const createCodexState = (roots: string[]): CodexState => ({
  roots,
  tools: new Set(),
  edits: new Map(),
  mcp: new Map(),
  usage: null,
  windows: null,
  error: null,
});

type RateWindow = { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown } | null;

/**
 * Codex's rate-limit snapshot (`account/rateLimits/read` and `/updated`, codex-cli 0.153.2) as ion's windows: its
 * primary (5 h) and secondary (week) windows; null when it names neither.
 */
export function windowsOf(snapshot: unknown): UsageWindow[] | null {
  const s = (snapshot ?? {}) as { primary?: RateWindow; secondary?: RateWindow };
  const windows = [s.primary, s.secondary]
    .map((w) => (w ? usageWindow(w.windowDurationMins, w.usedPercent, w.resetsAt) : null))
    .filter((w): w is UsageWindow => w !== null);
  return windows.length ? windows : null;
}

const str = (x: unknown) => (typeof x === "string" ? x : "");

/** A path inside the chat's folder as a relative one; anything else as it is. */
function shorten(path: string, roots: string[]): string {
  const rel = roots.map((r) => relative(r, path)).find((r) => r && !r.startsWith("..") && !isAbsolute(r));
  return rel ?? path;
}

/** Where a change leaves the file: its new path when moved. */
const finalPath = (c: Change) => str(c.kind?.move_path) || str(c.path);
const changesOf = (item: Json) => (Array.isArray(item.changes) ? (item.changes as Change[]) : []);

const lineCount = (text: string) => (text ? text.replace(/\n$/, "").split("\n").length : 0);
const countLines = (diff: string, sign: "+" | "-") =>
  diff.split("\n").filter((l) => l.startsWith(sign) && !l.startsWith(sign.repeat(3))).length;

function fileChanged(c: Change, roots: string[]): AdapterEvent {
  const kind = c.kind?.type;
  const diff = str(c.diff);
  const path = shorten(finalPath(c), roots);
  if (kind === "add")
    return { type: EV.fileChanged, data: { path, change: "add", added: lineCount(diff), removed: null } };
  if (kind === "delete")
    return { type: EV.fileChanged, data: { path, change: "delete", added: null, removed: lineCount(diff) } };
  const data = { path, change: "modify", added: countLines(diff, "+"), removed: countLines(diff, "-") };
  return { type: EV.fileChanged, data };
}

function toolStarted(
  s: CodexState,
  id: string,
  d: { name: string; kind: string; summary: string; input?: unknown },
) {
  s.tools.add(id);
  const input = toolText(d.input, TOOL_INPUT_MAX);
  const data = {
    toolId: id,
    name: d.name,
    kind: d.kind,
    summary: d.summary.slice(0, 80),
    ...(input ? { input } : {}),
  };
  return [{ type: EV.toolStarted, data } as AdapterEvent];
}

function editStarted(item: Json, s: CodexState, id: string): AdapterEvent[] {
  const files = changesOf(item).map(finalPath).filter(Boolean);
  // What the approval is judged by: every path touched, a move's source as well as where it goes.
  const touched = changesOf(item).flatMap((c) => [str(c.path), str(c.kind?.move_path)]);
  s.edits.set(id, [...new Set(touched.filter(Boolean))]);
  const first = files[0] ? shorten(files[0], s.roots) : "files";
  const summary = files.length > 1 ? `${first} and ${files.length - 1} more` : first;
  const input = changesOf(item)
    .map((c) => `${finalPath(c)}\n${str(c.diff)}`)
    .join("\n");
  return toolStarted(s, id, { name: "apply_patch", kind: "edit", summary, input });
}

function itemStarted(item: Json, s: CodexState): AdapterEvent[] {
  const id = str(item.id);
  switch (item.type) {
    case "commandExecution": {
      const command = unwrapShell(str(item.command));
      return toolStarted(s, id, { name: "shell", kind: "command", summary: command, input: command });
    }
    case "fileChange":
      return editStarted(item, s, id);
    case "mcpToolCall": {
      const call = { server: str(item.server), tool: str(item.tool), arguments: item.arguments };
      s.mcp.set(id, call);
      const name = `mcp__${call.server}__${call.tool}`;
      return toolStarted(s, id, {
        name,
        kind: "mcp",
        summary: `${call.server}: ${call.tool}`,
        input: call.arguments,
      });
    }
    case "webSearch":
      return toolStarted(s, id, {
        name: "web_search",
        kind: "web",
        summary: str(item.query) || "Web search",
      });
    default:
      return [];
  }
}

/** A finished tool's output: a command's, or an MCP tool's result (else its error). */
function outputOf(item: Json): string | null {
  if (item.type === "commandExecution") return toolText(item.aggregatedOutput, TOOL_OUTPUT_MAX);
  if (item.type !== "mcpToolCall") return null;
  const result = (item.result ?? {}) as { content?: unknown };
  const error = (item.error ?? {}) as { message?: unknown };
  return toolText(blocksText(result.content) ?? error.message, TOOL_OUTPUT_MAX);
}

function itemCompleted(item: Json, s: CodexState): AdapterEvent[] {
  const id = str(item.id);
  if (item.type === "agentMessage") {
    const text = str(item.text);
    return text ? [{ type: EV.messageCompleted, data: { text } }] : [];
  }
  // A finished MCP call can't be approved any more.
  s.mcp.delete(id);
  if (!s.tools.delete(id)) return [];
  const ok = item.status === "completed" || (item.type === "webSearch" && item.status === undefined);
  const text = outputOf(item);
  const out: AdapterEvent[] = [
    ...(text ? [{ type: EV.toolOutput, data: { toolId: id, text } } as AdapterEvent] : []),
    { type: EV.toolFinished, data: { toolId: id, ok, summary: null } },
  ];
  if (item.type !== "fileChange" || !ok) return out;
  return [...out, ...changesOf(item).map((c) => fileChanged(c, s.roots))];
}

function noteUsage(p: Json, s: CodexState): void {
  const last = ((p.tokenUsage ?? {}) as { last?: { inputTokens?: unknown; outputTokens?: unknown } }).last;
  if (typeof last?.inputTokens !== "number" || typeof last.outputTokens !== "number") return;
  const u = s.usage ?? { inputTokens: 0, outputTokens: 0 };
  s.usage = {
    inputTokens: u.inputTokens + last.inputTokens,
    outputTokens: u.outputTokens + last.outputTokens,
  };
}

/** A sparse update's windows over the last ones, by name: one it doesn't name stays as it was. */
function mergeWindows(was: UsageWindow[] | null, now: UsageWindow[] | null): UsageWindow[] | null {
  if (!now) return was;
  const byName = new Map((was ?? []).map((w) => [w.name, w]));
  for (const w of now) byName.set(w.name, w);
  return [...byName.values()];
}

/** Translates one app-server notification into ion events. Pure apart from `state`. */
export function mapNotification(method: string, p: Json, s: CodexState): AdapterEvent[] {
  switch (method) {
    case "item/agentMessage/delta":
      return str(p.delta) ? [{ type: EV.messageDelta, data: { text: str(p.delta) } }] : [];
    case "item/reasoning/summaryTextDelta":
      return str(p.delta) ? [{ type: EV.thinkingDelta, data: { text: str(p.delta) } }] : [];
    case "item/started":
      return itemStarted((p.item ?? {}) as Json, s);
    case "item/completed":
      return itemCompleted((p.item ?? {}) as Json, s);
    case "thread/tokenUsage/updated":
      noteUsage(p, s);
      return [];
    case "account/rateLimits/updated":
      s.windows = mergeWindows(s.windows, windowsOf(p.rateLimits));
      return [];
    case "error":
      // Codex retries some errors itself (willRetry); only the last one that ends the turn counts.
      if (p.willRetry !== true) s.error = (p.error ?? { message: "Codex failed" }) as TurnError;
      return [];
    default:
      return [];
  }
}
