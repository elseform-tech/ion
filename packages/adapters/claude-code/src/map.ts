import {
  type AdapterEvent,
  blocksText,
  projectRoots,
  TOOL_INPUT_MAX,
  TOOL_OUTPUT_MAX,
  toolText,
} from "@ion/adapter-kit";
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
  /** Why the run is failing, when Claude Code said so before its result (rate limit, overload, account). */
  failure: Failure | null;
};

type Failure = { code: string; retryable: boolean; message: string; retryAfterS?: number };

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
  failure: null,
});

/** Waits longer than this aren't retried: they're a usage limit, not a blip. */
const MAX_WAIT_S = 120;
const TRANSIENT = new Set(["rate_limit", "overloaded", "server_error"]);

function mapRateLimit(msg: Obj, s: MapState): AdapterEvent[] {
  const info = (msg.rate_limit_info ?? {}) as { status?: string; resetsAt?: number };
  if (info.status !== "rejected") return [];
  const waitS =
    typeof info.resetsAt === "number" ? Math.max(0, info.resetsAt - Date.now() / 1000) : undefined;
  s.failure =
    waitS !== undefined && waitS > MAX_WAIT_S
      ? { code: "usage_limit", retryable: false, message: "Claude usage limit reached" }
      : {
          code: "rate_limit",
          retryable: true,
          message: "Rate limited",
          ...(waitS === undefined ? {} : { retryAfterS: Math.ceil(waitS) }),
        };
  return [];
}

function noteAssistantError(msg: Obj, s: MapState): void {
  const error = msg.error;
  if (typeof error !== "string" || error === "unknown" || s.failure) return;
  s.failure = { code: error, retryable: TRANSIENT.has(error), message: error.replaceAll("_", " ") };
}

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
        sessionId: s.sessionId,
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

/** The tool's input as text, when there is any. */
function withInput(input: Obj): { input?: string } {
  const text = Object.keys(input).length ? toolText(input, TOOL_INPUT_MAX) : null;
  return text ? { input: text } : {};
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
          ...withInput(input),
        },
      });
    }
  }
  return out;
}

/** One tool's result: its output, its end, and the file it changed (a successful edit). */
function toolResult(b: Obj & { tool_use_id: string }, s: MapState): AdapterEvent[] {
  const out: AdapterEvent[] = [];
  const ok = b.is_error !== true;
  const text = toolText(blocksText(b.content), TOOL_OUTPUT_MAX);
  if (text) out.push({ type: EV.toolOutput, data: { toolId: b.tool_use_id, text } });
  out.push({ type: EV.toolFinished, data: { toolId: b.tool_use_id, ok, summary: null } });
  const tool = s.tools.get(b.tool_use_id);
  const change =
    ok && tool && toolKind(tool.name) === "edit" ? fileChange(tool.name, tool.input, s.roots) : null;
  if (change) out.push({ type: EV.fileChanged, data: change });
  return out;
}

function mapToolResults(msg: Obj, s: MapState): AdapterEvent[] {
  return blocks(msg.message).flatMap((b) =>
    b.type === "tool_result" && typeof b.tool_use_id === "string"
      ? toolResult(b as Obj & { tool_use_id: string }, s)
      : [],
  );
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
    const fallback = {
      code: String(msg.subtype),
      retryable: false,
      message: errors || "Claude Code stopped",
    };
    out.push({ type: EV.error, data: s.failure ?? fallback });
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
      noteAssistantError(m, s);
      return mapAssistant(m, s);
    case "rate_limit_event":
      return mapRateLimit(m, s);
    case "user":
      return mapToolResults(m, s);
    case "result":
      return mapResult(m, s);
    default:
      return [];
  }
}
