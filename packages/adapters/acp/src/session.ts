import { randomUUID } from "node:crypto";
import {
  type AdapterEvent,
  createDeltaCoalescer,
  createEventQueue,
  type Decision,
  projectRoots,
  type Session,
  type StartOpts,
} from "@ion/adapter-kit";
import { EV } from "@ion/schema";
import type { Connection } from "./connection.js";
import { acpToolKind, createAcpState, mapUpdate } from "./map.js";

type Option = { optionId: string; kind: string };
/** Acceptable option kinds per decision, best first. Never wider than asked: "allow" is never "always". */
const ACCEPT: Record<Decision, string[]> = {
  allow: ["allow_once"],
  allow_always: ["allow_always", "allow_once"],
  deny: ["reject_once", "reject_always"],
};
const STATUS: Record<string, "done" | "interrupted"> = { end_turn: "done", cancelled: "interrupted" };

/** One ACP prompt turn mapped to ion events. The agent process lives as long as the turn. */
export function startAcpSession(
  c: Connection,
  opts: StartOpts,
  run: { harness: string; model: string },
): Session {
  const events = createEventQueue<AdapterEvent>();
  const state = createAcpState(projectRoots(opts.cwd));
  let finished = false;
  let interrupted = false;
  const text = createDeltaCoalescer((t) => events.push({ type: EV.messageDelta, data: { text: t } }));
  const thinking = createDeltaCoalescer((t) => events.push({ type: EV.thinkingDelta, data: { text: t } }));
  const emit = (e: AdapterEvent) => {
    if (finished) return;
    if (e.type === EV.messageDelta) return text.push((e.data as { text: string }).text);
    if (e.type === EV.thinkingDelta) return thinking.push((e.data as { text: string }).text);
    text.end();
    thinking.end();
    events.push(e);
  };
  const finish = (status: "done" | "interrupted" | "failed", message?: string) => {
    if (finished) return;
    if (message) emit({ type: EV.error, data: { code: "agent", retryable: false, message } });
    if (state.costUsd !== null)
      emit({
        type: EV.usageReported,
        data: { model: run.model, inputTokens: 0, outputTokens: 0, costUsd: state.costUsd },
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
  c.child.on("exit", () =>
    finish(interrupted ? "interrupted" : "failed", interrupted ? undefined : "The agent stopped"),
  );
  opts.signal.addEventListener("abort", () => c.child.kill());

  return {
    id: randomUUID(),
    nativeId: c.sessionId,
    async send({ text: t }) {
      emit({
        type: EV.runStarted,
        data: { harness: run.harness, model: run.model, effort: opts.effort, authMethod: "Signed in" },
      });
      c.rpc
        .request("session/prompt", { sessionId: c.sessionId, prompt: [{ type: "text", text: t }] })
        .then((r) => {
          const reason = String((r as { stopReason?: unknown }).stopReason);
          const status = STATUS[reason];
          finish(status ?? "failed", status ? undefined : `Stopped: ${reason}`);
        })
        .catch((e: Error) =>
          finish(interrupted ? "interrupted" : "failed", interrupted ? undefined : e.message),
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
  const kind = acpToolKind(tool.kind);
  emit({ type: EV.approvalRequested, data: { requestId, toolId, kind, summary } });
  const decision = await decide({
    requestId,
    toolId,
    toolName: String(tool.kind ?? "tool"),
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
