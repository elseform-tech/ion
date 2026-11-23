import { existsSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { type AdapterEvent, blocksText, TOOL_INPUT_MAX, TOOL_OUTPUT_MAX, toolText } from "@ion/adapter-kit";
import { EV, stripControl, type ToolKind } from "@ion/schema";

type Json = Record<string, unknown>;

/**
 * input: the tool's input once known; inputSent: whether it went out with tool.started; command: a command step's
 * command, once known; commandSent: whether its start was already summarized by it.
 */
type ToolInfo = {
  kind: string;
  locations: string[];
  /** Its files that weren't there when ion first heard of them (an edit there adds the file). */
  absent?: Set<string>;
  input?: string;
  inputSent?: boolean;
  command?: string;
  commandSent?: boolean;
};
/** `exists`: whether a file is there (an edited file that wasn't, before its step ran, is added). */
export type AcpState = {
  roots: string[];
  costUsd: number | null;
  tools: Map<string, ToolInfo>;
  exists: (path: string) => boolean;
};
export const createAcpState = (
  roots: string[],
  exists: (path: string) => boolean = existsSync,
): AcpState => ({ ...{ roots, costUsd: null, tools: new Map() }, exists });

/** The files not there yet, as ion first hears of a step's files (before it ran, for agents that say so then). */
function noteAbsent(t: ToolInfo, locs: string[], s: AcpState): void {
  for (const p of locs) {
    if (t.locations.includes(p) || t.absent?.has(p) || s.exists(p)) continue;
    t.absent ??= new Set();
    t.absent.add(p);
  }
}

const locationsOf = (u: Json): string[] =>
  (Array.isArray(u.locations) ? u.locations : [])
    .map((l) => (l && typeof l === "object" ? (l as { path?: unknown }).path : undefined))
    .filter((p): p is string => typeof p === "string");

/** Remembers what each update says about a tool (kind, files), since agents spread it across updates. */
function remember(u: Json, s: AcpState, toolId: string): ToolInfo | undefined {
  const t = s.tools.get(toolId);
  if (!t) return undefined;
  if (typeof u.kind === "string") t.kind = u.kind;
  const locs = locationsOf(u);
  // Heard of only once completed, a file is there already: it stays "modify" (nothing tells it was new).
  if (locs.length && u.status !== "completed") noteAbsent(t, locs, s);
  if (locs.length) t.locations = locs;
  const input = toolText(u.rawInput, TOOL_INPUT_MAX);
  if (input && !t.inputSent) t.input = input;
  const command = commandOf(u);
  if (command) t.command = command;
  return t;
}

/** A command step's command, from its raw input (opencode's bash, Grok's run). */
function commandOf(u: Json): string {
  if (acpToolKind(u.kind) !== "command" && u.kind !== undefined) return "";
  const raw = u.rawInput && typeof u.rawInput === "object" ? (u.rawInput as Json) : {};
  return typeof raw.command === "string" ? stripControl(raw.command).trim().slice(0, 80) : "";
}

/** A step's diffs as changed files: no old text, or empty old text for a file that wasn't there (Grok), is added. */
function diffChanges(u: Json, s: AcpState, tool: ToolInfo): AdapterEvent[] {
  const out: AdapterEvent[] = [];
  for (const c of (Array.isArray(u.content) ? u.content : []) as Json[]) {
    if (c.type !== "diff" || typeof c.path !== "string") continue;
    const isNew =
      c.oldText === undefined || c.oldText === null || (c.oldText === "" && !!tool.absent?.has(c.path));
    out.push({
      type: EV.fileChanged,
      data: {
        path: shorten(c.path, s.roots),
        change: isNew ? "add" : "modify",
        added: lines(c.newText),
        removed: isNew ? null : lines(c.oldText),
      },
    });
  }
  return out;
}

const KINDS: Record<string, ToolKind> = {
  read: "read",
  search: "search",
  edit: "edit",
  delete: "edit",
  move: "edit",
  execute: "command",
  fetch: "web",
};
export const acpToolKind = (kind: unknown): ToolKind => KINDS[String(kind)] ?? "other";

const lines = (s: unknown) => (typeof s === "string" && s.length ? s.split("\n").length : 0);

function shorten(path: string, roots: string[]): string {
  for (const root of roots) {
    const rel = relative(root, path);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  }
  return path;
}

const textOf = (content: unknown) => {
  const c = content as { type?: string; text?: unknown } | undefined;
  return c?.type === "text" && typeof c.text === "string" ? c.text : null;
};

/** A command only known after the step started is its summary now (tour, 2026-11-21: opencode showed "bash"). */
const lateSummary = (t: ToolInfo): string | null =>
  t.command && !t.commandSent && acpToolKind(t.kind) === "command" ? t.command : null;

function toolUpdate(u: Json, s: AcpState): AdapterEvent[] {
  const toolId = String(u.toolCallId);
  const tool = remember(u, s, toolId);
  if (!tool || (u.status !== "completed" && u.status !== "failed")) return [];
  s.tools.delete(toolId);
  const ok = u.status === "completed";
  // Its output: the text the agent shows for it, else its raw output.
  const raw = u.rawOutput as { output?: unknown } | undefined;
  const text = toolText(blocksText(u.content) ?? raw?.output ?? u.rawOutput, TOOL_OUTPUT_MAX);
  const late = tool.input && !tool.inputSent ? { input: tool.input } : {};
  const summary = lateSummary(tool);
  const out: AdapterEvent[] = [
    ...(text ? [{ type: EV.toolOutput, data: { toolId, text } }] : []),
    { type: EV.toolFinished, data: { toolId, ok, summary, ...late } },
  ];
  if (!ok) return out;
  const diffs = diffChanges(u, s, tool);
  if (diffs.length || acpToolKind(tool.kind) !== "edit") return [...out, ...diffs];
  // No diff (e.g. opencode): the edited files are the tool's locations; one that wasn't there before is added.
  const fromLocations: AdapterEvent[] = tool.locations.map((p) => ({
    type: EV.fileChanged,
    data: {
      path: shorten(p, s.roots),
      change: tool.absent?.has(p) ? "add" : "modify",
      added: null,
      removed: null,
    },
  }));
  return [...out, ...fromLocations];
}

/** A tool starting: what ion remembers of it, and its start event (with its input when the agent gives it). */
function toolCall(u: Json, s: AcpState): AdapterEvent {
  const toolId = String(u.toolCallId);
  const input = toolText(u.rawInput, TOOL_INPUT_MAX);
  const command = acpToolKind(u.kind) === "command" ? commandOf(u) : "";
  const info: ToolInfo = { kind: String(u.kind ?? "other"), locations: [] };
  noteAbsent(info, locationsOf(u), s);
  s.tools.set(toolId, {
    ...info,
    locations: locationsOf(u),
    inputSent: Boolean(input),
    commandSent: Boolean(command),
  });
  const found = webStep(u, s) ?? plainStep(u, s);
  const step = command ? { ...found, summary: command } : found;
  return {
    type: EV.toolStarted,
    data: { toolId, ...step, summary: step.summary.slice(0, 80), ...(input ? { input } : {}) },
  };
}

type Step = { name: string; kind: ToolKind; summary: string };

/** Grok's own web search or page read: its tool's name, and what it searched or read (its title only repeats it). */
function webStep(u: Json, s: AcpState): Step | null {
  const name = webToolOf(u);
  return name ? { name, kind: "web", summary: lookedFor(u.rawInput, s.roots) } : null;
}

/** Any other step: its kind's name, a routed tool's, or a plain title, with what it looked for. */
function plainStep(u: Json, s: AcpState): Step {
  const title = typeof u.title === "string" ? u.title : "Tool";
  const kind = acpToolKind(u.kind);
  // A tool of no known kind is named by its title ("grep"), with what it looked for.
  const known = kind !== "other";
  // Grok's use_tool routes another tool: its structured input names the real one, so that is the step's name.
  const routed = title === "use_tool" ? (u.rawInput as Json | undefined)?.tool_name : undefined;
  // The routed name labels the step only when it is plain; otherwise the step keeps "Use tool".
  const clean = typeof routed === "string" ? stripControl(routed).trim() : "";
  const via = /^[\w.-]{1,40}$/.test(clean) ? clean : undefined;
  if (via !== undefined) return { name: via, kind, summary: lookedFor(withoutToolName(u.rawInput), s.roots) };
  const plain = known ? String(u.kind) : (TITLES[title] ?? title).slice(0, 40);
  return { name: plain, kind, summary: known ? title : lookedFor(u.rawInput, s.roots) };
}

/**
 * opencode's web tools, by the title its steps carry (its own tool names; it sets no other identifier), each only
 * with the ACP kinds opencode gives it: a title alone never makes a command or an edit a web step.
 */
const WEB_TITLES: Record<string, { name: string; kinds: string[] }> = {
  websearch: { name: "websearch", kinds: ["search", "other"] },
  webfetch: { name: "webfetch", kinds: ["fetch"] },
};

/** What opencode's websearch takes (its own parameters): a search's input has no other key. */
const SEARCH_KEYS = new Set(["query", "numResults", "livecrawl", "type", "contextMaxCharacters"]);

/**
 * Whether a step titled as a web tool is one. opencode sends its websearch as kind "other" (seen live, 2026-11-21),
 * the catch-all every unknown tool also gets; so a step of that kind counts only with a search's input (no other
 * key, and no MCP tool name in it). A step of a specific kind ("search", "fetch") already says what it is.
 */
function kindAgrees(t: { kind?: unknown; rawInput?: unknown }): boolean {
  if (t.kind !== "other") return true;
  const raw = t.rawInput && typeof t.rawInput === "object" ? (t.rawInput as Json) : {};
  return Object.keys(raw).every((k) => SEARCH_KEYS.has(k));
}

/**
 * An agent's own web tool, from what its harness says of the step (never the model's words alone): opencode's by
 * its title and kind; Grok's search by its kind and title ("search", "Web search:") with its structured variant.
 * Else none.
 */
export function webToolOf(t: { kind?: unknown; title?: unknown; rawInput?: unknown }): string | undefined {
  const title = typeof t.title === "string" ? t.title : "";
  const byTitle = Object.hasOwn(WEB_TITLES, title) ? WEB_TITLES[title] : undefined;
  if (byTitle) return byTitle.kinds.includes(String(t.kind)) && kindAgrees(t) ? byTitle.name : undefined;
  const variant = t.rawInput && typeof t.rawInput === "object" ? (t.rawInput as Json).variant : undefined;
  return t.kind === "search" && title === "Web search:" && variant === "WebSearch" ? "web_search" : undefined;
}

/** Agents' own tools, by a plain name. */
const TITLES: Record<string, string> = {
  search_tool: "Find tool",
  use_tool: "Use tool",
  read_file: "Read",
  list_dir: "List",
  grep: "Grep",
};

/** A tool's input without its routed name (that is the step's name, not what it looked for). */
function withoutToolName(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const rest = { ...(raw as Record<string, unknown>) };
  delete rest.tool_name;
  return rest;
}

/** What a tool looked for: its pattern, query, file, folder, tool or address (a path from the worktree). */
function lookedFor(raw: unknown, roots: string[]): string {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const keys = [
    "pattern",
    "query",
    "target_file",
    "file_path",
    "path",
    "target_directory",
    "tool_name",
    "url",
  ];
  const v = keys.map((k) => r[k]).find((x) => typeof x === "string" && x);
  if (typeof v !== "string") return "";
  return isAbsolute(v) ? shorten(v, roots) : v;
}

/** Translates one ACP `session/update` into ion events. Pure apart from `state`. */
export function mapUpdate(u: Json, s: AcpState): AdapterEvent[] {
  switch (u.sessionUpdate) {
    case "agent_message_chunk": {
      const text = textOf(u.content);
      return text ? [{ type: EV.messageDelta, data: { text } }] : [];
    }
    case "agent_thought_chunk": {
      const text = textOf(u.content);
      return text ? [{ type: EV.thinkingDelta, data: { text } }] : [];
    }
    case "tool_call":
      return [toolCall(u, s)];
    case "tool_call_update":
      return toolUpdate(u, s);
    case "usage_update": {
      const cost = u.cost as { amount?: unknown } | undefined;
      if (typeof cost?.amount === "number") s.costUsd = cost.amount;
      return [];
    }
    default:
      return [];
  }
}
