import { type AdapterEvent, projectRoots } from "@ion/adapter-kit";
import { EV, type EffortLevel } from "@ion/schema";
import { fileChange, toolKind, toolSummary } from "./tools.js";

type Obj = Record<string, unknown>;
type Block = Obj & { type?: string };

export type MapState = {
  /** The project folder as given and its real path (they differ under symlinks, e.g. macOS /var). */
  roots: string[];
  effort: EffortLevel | null;
  authMethod: string;
  model: string | null;
  sessionId: string | null;
  interrupted: boolean;
  tools: Map<string, { name: string; input: Obj }>;
};

export const createMapState = (o: {
  cwd: string;
  effort: EffortLevel | null;
  authMethod: string;
}): MapState => ({
  roots: projectRoots(o.cwd),
  effort: o.effort,
  authMethod: o.authMethod,
  model: null,
  sessionId: null,
  interrupted: false,
  tools: new Map(),
});

const blocks = (m: unknown): Block[] => {
  const c = (m as { content?: unknown } | undefined)?.content;
  return Array.isArray(c) ? (c as Block[]) : [];
};

function mapInit(msg: Obj, s: MapState): AdapterEvent[] {
  s.model = typeof msg.model === "string" ? msg.model : s.model;
  s.sessionId = typeof msg.session_id === "string" ? msg.session_id : s.sessionId;
  return [
    {
      type: EV.runStarted,
      data: {
        harness: "claude-code",
        model: s.model ?? "unknown",
        effort: s.effort,
        authMethod: s.authMethod,
      },
    },
  ];
}

function mapStream(msg: Obj): AdapterEvent[] {
  const event = msg.event as { type?: string; delta?: Obj } | undefined;
  if (event?.type !== "content_block_delta" || !event.delta) return [];
  const d = event.delta;
  if (d.type === "text_delta" && typeof d.text === "string")
    return [{ type: EV.messageDelta, data: { text: d.text } }];
  if (d.type === "thinking_delta" && typeof d.thinking === "string")
    return [{ type: EV.thinkingDelta, data: { text: d.thinking } }];
  return [];
}

function mapAssistant(msg: Obj, s: MapState): AdapterEvent[] {
  const out: AdapterEvent[] = [];
  for (const b of blocks(msg.message)) {
    if (b.type === "text" && typeof b.text === "string")
      out.push({ type: EV.messageCompleted, data: { text: b.text } });
    if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
      const input = (b.input ?? {}) as Obj;
      s.tools.set(b.id, { name: b.name, input });
      out.push({
        type: EV.toolStarted,
        data: {
          toolId: b.id,
          name: b.name,
          kind: toolKind(b.name),
          summary: toolSummary(b.name, input, s.roots),
        },
      });
    }
  }
  return out;
}

function mapToolResults(msg: Obj, s: MapState): AdapterEvent[] {
  const out: AdapterEvent[] = [];
  for (const b of blocks(msg.message)) {
    if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
    const ok = b.is_error !== true;
    out.push({ type: EV.toolFinished, data: { toolId: b.tool_use_id, ok, summary: null } });
    const tool = s.tools.get(b.tool_use_id);
    if (ok && tool && toolKind(tool.name) === "edit") {
      const change = fileChange(tool.name, tool.input, s.roots);
      if (change) out.push({ type: EV.fileChanged, data: change });
    }
  }
  return out;
}

function endStatus(subtype: string, s: MapState): "done" | "interrupted" | "capped" | "failed" {
  if (subtype === "success") return "done";
  if (s.interrupted) return "interrupted";
  if (subtype === "error_max_budget_usd") return "capped";
  return "failed";
}

function mapResult(msg: Obj, s: MapState): AdapterEvent[] {
  const usage = (msg.usage ?? {}) as Obj;
  const model = s.model ?? Object.keys((msg.modelUsage ?? {}) as Obj)[0] ?? "unknown";
  const num = (x: unknown) => (typeof x === "number" && x >= 0 ? x : 0);
  const out: AdapterEvent[] = [
    {
      type: EV.usageReported,
      data: {
        model,
        inputTokens: num(usage.input_tokens),
        outputTokens: num(usage.output_tokens),
        costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null,
      },
    },
  ];
  const status = endStatus(String(msg.subtype), s);
  if (status === "failed") {
    const errors = Array.isArray(msg.errors) ? msg.errors.join("; ") : "";
    out.push({
      type: EV.error,
      data: { code: String(msg.subtype), retryable: false, message: errors || "Claude Code stopped" },
    });
  }
  out.push({ type: EV.runFinished, data: { status } });
  return out;
}

/** Translates one Claude Agent SDK message into ion events. Pure apart from `state`. */
export function mapSdkMessage(msg: unknown, s: MapState): AdapterEvent[] {
  const m = (msg ?? {}) as Obj;
  switch (m.type) {
    case "system":
      return m.subtype === "init" ? mapInit(m, s) : [];
    case "stream_event":
      return mapStream(m);
    case "assistant":
      return mapAssistant(m, s);
    case "user":
      return mapToolResults(m, s);
    case "result":
      return mapResult(m, s);
    default:
      return [];
  }
}
