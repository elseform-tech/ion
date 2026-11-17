import { isAbsolute, relative } from "node:path";
import type { AdapterEvent } from "@ion/adapter-kit";
import { EV, type ToolKind } from "@ion/schema";

type Json = Record<string, unknown>;

type ToolInfo = { kind: string; locations: string[] };
export type AcpState = { roots: string[]; costUsd: number | null; tools: Map<string, ToolInfo> };
export const createAcpState = (roots: string[]): AcpState => ({ roots, costUsd: null, tools: new Map() });

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
  if (locs.length) t.locations = locs;
  return t;
}

function diffChanges(u: Json, s: AcpState): AdapterEvent[] {
  const out: AdapterEvent[] = [];
  for (const c of (Array.isArray(u.content) ? u.content : []) as Json[]) {
    if (c.type !== "diff" || typeof c.path !== "string") continue;
    const isNew = c.oldText === undefined || c.oldText === null;
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

function toolUpdate(u: Json, s: AcpState): AdapterEvent[] {
  const toolId = String(u.toolCallId);
  const tool = remember(u, s, toolId);
  if (!tool || (u.status !== "completed" && u.status !== "failed")) return [];
  s.tools.delete(toolId);
  const ok = u.status === "completed";
  const out: AdapterEvent[] = [{ type: EV.toolFinished, data: { toolId, ok, summary: null } }];
  if (!ok) return out;
  const diffs = diffChanges(u, s);
  if (diffs.length || acpToolKind(tool.kind) !== "edit") return [...out, ...diffs];
  // No diff (e.g. opencode): the edited files are the tool's locations.
  const fromLocations: AdapterEvent[] = tool.locations.map((p) => ({
    type: EV.fileChanged,
    data: { path: shorten(p, s.roots), change: "modify", added: null, removed: null },
  }));
  return [...out, ...fromLocations];
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
    case "tool_call": {
      const toolId = String(u.toolCallId);
      s.tools.set(toolId, { kind: String(u.kind ?? "other"), locations: locationsOf(u) });
      const title = typeof u.title === "string" ? u.title : "Tool";
      return [
        {
          type: EV.toolStarted,
          data: {
            toolId,
            name: String(u.kind ?? "other"),
            kind: acpToolKind(u.kind),
            summary: title.slice(0, 80),
          },
        },
      ];
    }
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
