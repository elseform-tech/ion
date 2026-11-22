import { randomBytes, randomUUID } from "node:crypto";
import {
  type AdapterEvent,
  createDeltaCoalescer,
  createEventQueue,
  type EventQueue,
  type Decision,
  projectRoots,
  RpcError,
  type Session,
  type StartOpts,
} from "@ion/adapter-kit";
import { EV } from "@ion/schema";
import type { Connection } from "./connection.js";
import { acpToolKind, createAcpState, mapUpdate, webToolOf } from "./map.js";

type Option = { optionId: string; kind: string };
/** Acceptable option kinds per decision, best first. Never wider than asked: "allow" is never "always". */
const ACCEPT: Record<Decision, string[]> = {
  allow: ["allow_once"],
  allow_always: ["allow_always", "allow_once"],
  deny: ["reject_once", "reject_always"],
};
type Usage = { inputTokens: number; outputTokens: number; costUsd?: number };

/** Grok's cost unit (`_meta.usage.costUsdTicks`, Grok 1.0.92): 1e-10 USD. */
const USD_PER_TICK = 1e-10;

/** Token counts from a prompt result: `usage` (ACP unstable) or `_meta` (Grok, with its cost in ticks). */
function usageOf(r: unknown): Usage | null {
  const o = (r ?? {}) as { usage?: Record<string, unknown>; _meta?: Record<string, unknown> };
  for (const src of [o.usage, o._meta]) {
    if (src && typeof src.inputTokens === "number" && typeof src.outputTokens === "number") {
      const ticks = (src.usage as { costUsdTicks?: unknown } | undefined)?.costUsdTicks;
      const cost = typeof ticks === "number" && ticks >= 0 ? { costUsd: ticks * USD_PER_TICK } : {};
      return { inputTokens: src.inputTokens, outputTokens: src.outputTokens, ...cost };
    }
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
  // ACP streams text only: the whole message is sent as message.completed when it ends (before anything else).
  let message = "";
  return (e) => {
    if (finished()) return;
    if (e.type === EV.messageDelta) {
      message += (e.data as { text: string }).text;
      return text.push((e.data as { text: string }).text);
    }
    if (e.type === EV.thinkingDelta) return thinking.push((e.data as { text: string }).text);
    text.end();
    thinking.end();
    if (message) events.push({ type: EV.messageCompleted, data: { text: message } });
    message = "";
    events.push(e);
  };
}

/** A turn's prompt: ion's instructions as their own marked block first (ACP has no system prompt), then yours. */
export function promptOf(text: string, instructions?: string): { type: "text"; text: string }[] {
  // Your text (or a brief ion chief's model wrote) can't open or close ion's block and pose as ion.
  const yours = { type: "text" as const, text: text.replace(/<\/?ion-instructions/gi, "‹ion-instructions") };
  if (!instructions) return [yours];
  // A random id per turn fences ion's block (as ion's data blocks are): no text can guess its closing line.
  const id = randomBytes(8).toString("hex");
  return [
    { type: "text", text: `<ion-instructions id="${id}">\n${instructions}\n</ion-instructions id="${id}">` },
    yours,
  ];
}

/** One ACP prompt turn mapped to ion events. The agent process lives as long as the turn. */
type Failure = { code: string; retryable: boolean; message: string; limit?: { resetsAt?: string } };
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

/** Updates that are the agent getting on with the turn (others, like its commands list, aren't). */
const PROGRESS = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "usage_update",
]);

/**
 * The silence check (task review, 2026-11-21): rolling, reset by each bit of progress, paused while ion holds a
 * permission; past its time the turn fails with the agent's own logged reason when it gave one, else `why`. A log
 * line saying the agent can't go on fails it at once, as its limit (`limited`).
 */
export function silence(
  silent: { ms: number; why: string } | undefined,
  c: Connection,
  fail: (why: string, limited?: boolean) => void,
) {
  // The agent's log says it can't go on (opencode out of quota, which then retries quietly): the turn fails now, with
  // its reason, not at the check (Judge eval, 2026-11-22: every judge verdict on opencode waited its 30 s). The
  // listener goes with the agent's process (a warm agent's session: when it ends).
  c.giveUp?.((why) => fail(why, true));
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Why the check is paused: a call ion holds, a tool still running (re-review, 2026-11-21). */
  const paused = new Set<string>();
  /** Pauses that end by themselves (a tool whose update never comes), by why. */
  const limits = new Map<string, ReturnType<typeof setTimeout>>();
  const start = () => {
    clearTimeout(timer);
    if (!silent || paused.size) return;
    // The agent's own reason, as its harness words it (opencode's: "opencode's free usage is used up …").
    timer = setTimeout(() => fail(c.failure?.() ?? silent.why), silent.ms);
    timer.unref();
  };
  return {
    heard: start,
    /** maxMs: the pause ends by itself after this long (task review, 2026-11-21). */
    pause(why: string, maxMs?: number) {
      paused.add(why);
      clearTimeout(timer);
      if (maxMs === undefined || limits.has(why)) return;
      const limit = setTimeout(() => this.resume(why), maxMs);
      limit.unref();
      limits.set(why, limit);
    },
    resume(why: string) {
      clearTimeout(limits.get(why));
      limits.delete(why);
      if (paused.delete(why)) start();
    },
  };
}

type Quiet = ReturnType<typeof silence>;

/** ion holding a call for your answer isn't the agent being quiet: the silence check waits for the answer. */
async function held<T>(quiet: Quiet, answer: Promise<T>): Promise<T> {
  const why = `ask:${randomUUID()}`;
  quiet.pause(why);
  try {
    return await answer;
  } finally {
    quiet.resume(why);
  }
}

/** The longest a running tool pauses the check: past it, a lost update doesn't keep a stuck run waiting. */
const TOOL_PAUSE_MS = 30 * 60_000;

/** A tool call that's running pauses the check until its update says it's done (at most TOOL_PAUSE_MS). */
function trackTools(u: Record<string, unknown>, quiet: Quiet): void {
  const id = `tool:${String(u.toolCallId ?? "")}`;
  const status = String(u.status ?? "");
  if (status === "completed" || status === "failed") quiet.resume(id);
  else if (u.sessionUpdate === "tool_call") quiet.pause(id, TOOL_PAUSE_MS);
}

/** The turn's usage: tokens from the prompt result, cost from its updates (opencode) or its result (Grok). */
function usageEvent(model: string, costUsd: number | null, usage: Usage | null): AdapterEvent {
  return {
    type: EV.usageReported,
    data: {
      model,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      costUsd: costUsd ?? usage?.costUsd ?? null,
    },
  };
}

/** A turn the agent went quiet on; what its log says it can't get past is its limit (opencode's names no reset). */
const quietFailure = (why: string, limited?: boolean): Failure =>
  limited
    ? { code: "usage_limit", retryable: false, message: why, limit: {} }
    : { code: "agent", retryable: false, message: why };

export function startAcpSession(
  c: Connection,
  opts: StartOpts,
  run: { harness: string; model: string; silent?: { ms: number; why: string } },
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
    if (state.costUsd !== null || usage) emit(usageEvent(run.model, state.costUsd, usage));
    emit({ type: EV.runFinished, data: { status } });
    finished = true;
    events.end();
    setTimeout(() => c.child.kill(), 100).unref();
  };

  const quiet = silence(run.silent, c, (why, limited) => finish("failed", quietFailure(why, limited)));
  c.rpc.onNotification("session/update", (p) => {
    const u = (p.update ?? {}) as Record<string, unknown>;
    if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") trackTools(u, quiet);
    if (PROGRESS.has(String(u.sessionUpdate))) quiet.heard();
    for (const e of mapUpdate(u, state)) emit(e);
  });
  c.rpc.onRequest("session/request_permission", (p) =>
    interrupted
      ? Promise.resolve({ outcome: { outcome: "cancelled" } })
      : held(quiet, answerPermission(p, opts.decide, emit)),
  );
  // ion holding a call through its gate (Grok's hook, opencode's plugin) tells the session too.
  opts.holding?.on((on) => (on ? quiet.pause("ion") : quiet.resume("ion")));
  c.child.on("exit", () => finish(interrupted ? "interrupted" : "failed", interrupted ? undefined : CRASH));
  opts.signal.addEventListener("abort", () => c.child.kill());

  return {
    id: randomUUID(),
    nativeId: c.sessionId,
    async send({ text: t }) {
      emit(startedEvent(run, opts, c.sessionId));
      // No progress for a while after the prompt: the agent is stuck (an expired key or no quota leaves opencode like
      // this), so say why.
      quiet.heard();
      c.rpc
        .request("session/prompt", { sessionId: c.sessionId, prompt: promptOf(t, opts.instructions) })
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
  const mcp = mcpToolOf(tool);
  // Grok's own web tools, named from its structured call: ion decides what's a search by this name.
  const web = mcp ? undefined : webToolOf(tool);
  let kind = acpToolKind(tool.kind);
  if (web) kind = "web";
  if (mcp) kind = "mcp";
  emit({ type: EV.approvalRequested, data: { requestId, toolId, kind, summary } });
  const decision = await decide({
    requestId,
    toolId,
    toolName: mcp?.name ?? web ?? String(tool.kind ?? "tool"),
    mcpServer: mcp?.server ?? null,
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
/** An MCP tool call's server and full name: Grok sends `{ variant: "UseTool", tool_name: "<server>__<tool>" }`. */
function mcpToolOf(tool: AcpToolCall): { server: string; name: string } | null {
  const raw = (typeof tool.rawInput === "object" && tool.rawInput) || {};
  const { variant, tool_name: name } = raw as { variant?: unknown; tool_name?: unknown };
  if (variant !== "UseTool" || typeof name !== "string") return null;
  const m = /^(.+?)__[^_]/.exec(name);
  return m ? { server: m[1]!, name } : null;
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
