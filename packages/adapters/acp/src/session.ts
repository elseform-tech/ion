import { randomUUID } from "node:crypto";
import {
  type AdapterEvent,
  createDeltaCoalescer,
  createEventQueue,
  type EventQueue,
  type Decision,
  projectRoots,
  type Session,
  type StartOpts,
} from "@ion/adapter-kit";
import { EV } from "@ion/schema";
import type { Connection } from "./connection.js";
import { acpToolKind, createAcpState, mapUpdate } from "./map.js";
import { RpcError } from "./rpc.js";

type Option = { optionId: string; kind: string };
/** Acceptable option kinds per decision, best first. Never wider than asked: "allow" is never "always". */
const ACCEPT: Record<Decision, string[]> = {
  allow: ["allow_once"],
  allow_always: ["allow_always", "allow_once"],
  deny: ["reject_once", "reject_always"],
};
type Usage = { inputTokens: number; outputTokens: number };

/** Token counts from a prompt result: `usage` (ACP unstable) or `_meta` (Grok). */
function usageOf(r: unknown): Usage | null {
  const o = (r ?? {}) as { usage?: Record<string, unknown>; _meta?: Record<string, unknown> };
  for (const src of [o.usage, o._meta]) {
    if (src && typeof src.inputTokens === "number" && typeof src.outputTokens === "number")
      return { inputTokens: src.inputTokens, outputTokens: src.outputTokens };
  }
  return null;
}

/** A "cancelled" turn is only an interrupt if ion asked for one; agents also end that way after a refusal. */
const statusOf = (reason: string, interrupted: boolean): "done" | "interrupted" | null => {
  if (reason === "end_turn") return "done";
  if (reason === "cancelled") return interrupted ? "interrupted" : "done";
  return null;
};

/** Pushes events, batching streamed text and thinking; nothing after the run has finished. */
function batchingEmitter(
  events: EventQueue<AdapterEvent>,
  finished: () => boolean,
): (e: AdapterEvent) => void {
  const text = createDeltaCoalescer((t) => events.push({ type: EV.messageDelta, data: { text: t } }));
  const thinking = createDeltaCoalescer((t) => events.push({ type: EV.thinkingDelta, data: { text: t } }));
  return (e) => {
    if (finished()) return;
    if (e.type === EV.messageDelta) return text.push((e.data as { text: string }).text);
    if (e.type === EV.thinkingDelta) return thinking.push((e.data as { text: string }).text);
    text.end();
    thinking.end();
    events.push(e);
  };
}

/** One ACP prompt turn mapped to ion events. The agent process lives as long as the turn. */
type Failure = { code: string; retryable: boolean; message: string };
const CRASH: Failure = { code: "crash", retryable: true, message: "The agent stopped" };
const RATE_LIMIT = /rate.?limit|\b429\b|overloaded|too many requests|timed? ?out/i;

/** A transport error (the agent died) or a rate limit is transient; any other agent error is a real failure. */
function failureOf(e: Error): Failure {
  if (!(e instanceof RpcError)) return { ...CRASH, message: e.message };
  if (RATE_LIMIT.test(e.message)) return { code: "rate_limit", retryable: true, message: e.message };
  return { code: "agent", retryable: false, message: e.message };
}

function startedEvent(
  run: { harness: string; model: string },
  opts: StartOpts,
  sessionId: string,
): AdapterEvent {
  const data = {
    harness: run.harness,
    model: run.model,
    effort: opts.effort,
    authMethod: "Signed in",
    sessionId,
  };
  return { type: EV.runStarted, data };
}

export function startAcpSession(
  c: Connection,
  opts: StartOpts,
  run: { harness: string; model: string },
): Session {
  const events = createEventQueue<AdapterEvent>();
  const state = createAcpState(projectRoots(opts.cwd));
  let finished = false;
  let interrupted = false;
  const emit = batchingEmitter(events, () => finished);
  const finish = (
    status: "done" | "interrupted" | "failed",
    failure?: Failure,
    usage: Usage | null = null,
  ) => {
    if (finished) return;
    if (failure) emit({ type: EV.error, data: failure });
    if (state.costUsd !== null || usage)
      emit({
        type: EV.usageReported,
        data: {
          model: run.model,
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          costUsd: state.costUsd,
        },
      });
    emit({ type: EV.runFinished, data: { status } });
    finished = true;
    events.end();
    setTimeout(() => c.child.kill(), 100).unref();
  };

  c.rpc.onNotification("session/update", (p) => {
    for (const e of mapUpdate((p.update ?? {}) as Record<string, unknown>, state)) emit(e);
  });
  c.rpc.onRequest("session/request_permission", (p) =>
    interrupted
      ? Promise.resolve({ outcome: { outcome: "cancelled" } })
      : answerPermission(p, opts.decide, emit),
  );
  c.child.on("exit", () => finish(interrupted ? "interrupted" : "failed", interrupted ? undefined : CRASH));
  opts.signal.addEventListener("abort", () => c.child.kill());

  return {
    id: randomUUID(),
    nativeId: c.sessionId,
    async send({ text: t }) {
      emit(startedEvent(run, opts, c.sessionId));
      c.rpc
        .request("session/prompt", { sessionId: c.sessionId, prompt: [{ type: "text", text: t }] })
        .then((r) => {
          const reason = String((r as { stopReason?: unknown }).stopReason);
          const status = statusOf(reason, interrupted);
          const failure = status
            ? undefined
            : { code: "agent", retryable: false, message: `Stopped: ${reason}` };
          finish(status ?? "failed", failure, usageOf(r));
        })
        .catch((e: Error) =>
          finish(interrupted ? "interrupted" : "failed", interrupted ? undefined : failureOf(e)),
        );
    },
    events: () => events,
    async interrupt() {
      interrupted = true;
      c.rpc.notify("session/cancel", { sessionId: c.sessionId });
      setTimeout(() => c.child.kill(), 3000).unref();
    },
    async close() {
      if (!finished) c.child.kill();
    },
  };
}

/** Asks the daemon about one ACP permission request and picks the matching option. */
async function answerPermissionUnsafe(
  p: Record<string, unknown>,
  decide: StartOpts["decide"],
  emit: (e: AdapterEvent) => void,
): Promise<{ outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } }> {
  const tool = (p.toolCall ?? {}) as AcpToolCall;
  const toolId = String(tool.toolCallId ?? "");
  const requestId = `${toolId}:${randomUUID().slice(0, 8)}`;
  const summary = String(tool.title ?? "A tool");
  const mcpServer = mcpServerOf(tool);
  const kind = mcpServer ? "mcp" : acpToolKind(tool.kind);
  emit({ type: EV.approvalRequested, data: { requestId, toolId, kind, summary } });
  const decision = await decide({
    requestId,
    toolId,
    toolName: String(tool.kind ?? "tool"),
    mcpServer,
    kind,
    summary,
    input: inputOf(tool),
  });
  const options = (p.options ?? []) as Option[];
  const chosen = ACCEPT[decision].map((k) => options.find((o) => o.kind === k)).find(Boolean);
  return chosen
    ? { outcome: { outcome: "selected", optionId: chosen.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

type AcpToolCall = {
  toolCallId?: string;
  title?: string;
  kind?: string;
  locations?: unknown;
  rawInput?: unknown;
};

/** What the daemon's policy needs: the agent's raw input plus every path in `locations`. */
/** An MCP tool call's server: Grok sends `{ variant: "UseTool", tool_name: "<server>__<tool>" }`. */
function mcpServerOf(tool: AcpToolCall): string | null {
  const raw = (typeof tool.rawInput === "object" && tool.rawInput) || {};
  const { variant, tool_name: name } = raw as { variant?: unknown; tool_name?: unknown };
  if (variant !== "UseTool" || typeof name !== "string") return null;
  const m = /^(.+?)__[^_]/.exec(name);
  return m ? m[1]! : null;
}

function inputOf(tool: AcpToolCall): Record<string, unknown> {
  const raw =
    typeof tool.rawInput === "object" && tool.rawInput !== null
      ? (tool.rawInput as Record<string, unknown>)
      : {};
  const locs: unknown[] = Array.isArray(tool.locations) ? tool.locations : [];
  const locations = locs
    .map((l) => (l && typeof l === "object" ? (l as { path?: unknown }).path : undefined))
    .filter((p): p is string => typeof p === "string");
  return { ...raw, locations };
}

type PermissionOutcome = { outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } };

/** Asks the daemon about one ACP permission request. Any error refuses (fail closed). */
export async function answerPermission(
  p: Record<string, unknown>,
  decide: StartOpts["decide"],
  emit: (e: AdapterEvent) => void,
): Promise<PermissionOutcome> {
  try {
    return await answerPermissionUnsafe(p, decide, emit);
  } catch {
    return { outcome: { outcome: "cancelled" } };
  }
}
