import { randomUUID } from "node:crypto";
import {
  type AdapterEvent,
  type ApprovalRequest,
  createDeltaCoalescer,
  createEventQueue,
  type Decision,
  type EventQueue,
  projectRoots,
  RpcError,
  type Session,
  type StartOpts,
} from "@ion/adapter-kit";
import { EV, type UsageWindow } from "@ion/schema";
import { type Connection, effortOf, SIGNED_OUT } from "./connection.js";
import { unwrapShell } from "./gate.js";
import { type CodexState, createCodexState, mapNotification, type TurnError, windowsOf } from "./map.js";

type Json = Record<string, unknown>;
type Failure = { code: string; retryable: boolean; message: string; limit?: { resetsAt?: string } };
const CRASH: Failure = { code: "crash", retryable: true, message: "Codex stopped" };

const NOTIFICATIONS = [
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/started",
  "item/completed",
  "thread/tokenUsage/updated",
  "account/rateLimits/updated",
  "error",
];

/** The reset of the window that's full, when Codex said one is: when its used-up plan goes on again. */
function limitOf(windows: UsageWindow[] | null): { resetsAt?: string } {
  const full = (windows ?? []).filter((w) => w.usedPercent >= 100 && w.resetsAt).map((w) => w.resetsAt!);
  return full.length ? { resetsAt: full.sort().at(-1)! } : {};
}

/**
 * Codex's error kinds: a rate limit or a dropped connection is worth retrying; a used-up plan isn't, and is its
 * limit (until the full window resets).
 */
function failureOf(e: TurnError | null, windows: UsageWindow[] | null = null): Failure {
  const message = e?.message || "Codex failed";
  const info = e?.codexErrorInfo;
  const kind = typeof info === "string" ? info : Object.keys((info ?? {}) as object)[0];
  if (kind === "rateLimitExceeded" || kind === "serverOverloaded")
    return { code: "rate_limit", retryable: true, message };
  if (kind === "usageLimitExceeded")
    return { code: "quota", retryable: false, message, limit: limitOf(windows) };
  if (kind === "unauthorized") return { code: "auth", retryable: false, message: SIGNED_OUT };
  const network = /Connection|Disconnected|FailedAttempts|internalServerError/.test(String(kind));
  return { code: network ? "network" : "agent", retryable: network, message };
}

/** Pushes events, batching streamed text and thinking; nothing once the run has finished. */
function batching(push: (e: AdapterEvent) => void, finished: () => boolean): (e: AdapterEvent) => void {
  const text = createDeltaCoalescer((t) => push({ type: EV.messageDelta, data: { text: t } }));
  const thinking = createDeltaCoalescer((t) => push({ type: EV.thinkingDelta, data: { text: t } }));
  return (e) => {
    if (finished()) return;
    if (e.type === EV.messageDelta) return text.push((e.data as { text: string }).text);
    if (e.type === EV.thinkingDelta) return thinking.push((e.data as { text: string }).text);
    text.end();
    thinking.end();
    push(e);
  };
}

// ---- approvals: Codex's own requests, each decided by ion --------------------------------------------------

type Ask = (req: Omit<ApprovalRequest, "requestId">) => Promise<Decision>;

/** Emits the request, asks the daemon, and refuses if anything goes wrong (fail closed). */
function asker(opts: StartOpts, emit: (e: AdapterEvent) => void): Ask {
  return async (r) => {
    if (opts.bare) return "deny";
    const requestId = `${r.toolId}:${randomUUID().slice(0, 8)}`;
    emit({
      type: EV.approvalRequested,
      data: { requestId, toolId: r.toolId, kind: r.kind, summary: r.summary },
    });
    try {
      return await opts.decide({ requestId, ...r });
    } catch {
      return "deny";
    }
  };
}

/** Never wider than asked: "allow" is this call only; "always" is this session's, when Codex offers it. */
function verdict(d: Decision, offered: unknown): string {
  if (d === "deny") return "decline";
  const session = !Array.isArray(offered) || offered.includes("acceptForSession");
  return d === "allow_always" && session ? "acceptForSession" : "accept";
}

async function commandApproval(p: Json, ask: Ask, cwd: string) {
  const command = unwrapShell(typeof p.command === "string" ? p.command : "");
  // ion judges a command and nothing more: none at all, or one asking for network access or more permissions
  // too (which ion doesn't weigh), is declined.
  if (!command.trim() || p.networkApprovalContext != null || p.additionalPermissions != null)
    return { decision: "decline" };
  const d = await ask({
    toolId: String(p.itemId),
    toolName: "Bash",
    kind: "command",
    summary: command,
    input: { command, cwd: typeof p.cwd === "string" ? p.cwd : cwd },
  });
  return { decision: verdict(d, p.availableDecisions) };
}

async function fileApproval(p: Json, ask: Ask, s: CodexState) {
  const toolId = String(p.itemId);
  const files = s.edits.get(toolId) ?? [];
  // Files ion never saw (no item started for it): nothing to judge, so declined, never an empty path.
  if (!files.length) return { decision: "decline" };
  const root = typeof p.grantRoot === "string" && p.grantRoot ? { root: p.grantRoot } : {};
  const d = await ask({
    toolId,
    toolName: "apply_patch",
    kind: "edit",
    summary: files[0]!,
    input: { file_path: files[0], locations: files, ...root },
  });
  return { decision: verdict(d, null) };
}

const elicitation = (action: string) => ({ action, content: null, _meta: null });

/**
 * The one MCP call a form is about. Codex names only the server (and the tool in its message), never the call, so
 * it must be the single call still running on that server, for that tool; none or several: no call (declined).
 */
function mcpCallFor(p: Json, s: CodexState) {
  const server = String(p.serverName);
  const named = /tool "([^"]+)"/.exec(String(p.message))?.[1];
  const running = [...s.mcp].filter(([, c]) => c.server === server && (!named || c.tool === named));
  return running.length === 1 ? running[0]! : null;
}

async function mcpApproval(p: Json, ask: Ask, s: CodexState) {
  const meta = (p._meta ?? {}) as Json;
  if (meta.codex_approval_kind !== "mcp_tool_call") return elicitation("decline");
  const found = mcpCallFor(p, s);
  if (!found) return elicitation("decline");
  const [toolId, call] = found;
  const d = await ask({
    toolId,
    toolName: `mcp__${call.server}__${call.tool}`,
    mcpServer: call.server,
    kind: "mcp",
    summary: `${call.server}: ${call.tool}`,
    input: (meta.tool_params ?? call.arguments ?? {}) as Record<string, unknown>,
  });
  return elicitation(d === "deny" ? "decline" : "accept");
}

const NO_CARD = "There's no one to answer this here. Ask the user with ion's ask tool instead.";

function answerRequests(c: Connection, opts: StartOpts, s: CodexState, emit: (e: AdapterEvent) => void) {
  const ask = asker(opts, emit);
  c.rpc.onRequest("item/commandExecution/requestApproval", (p) => commandApproval(p, ask, opts.cwd));
  c.rpc.onRequest("item/fileChange/requestApproval", (p) => fileApproval(p, ask, s));
  c.rpc.onRequest("mcpServer/elicitation/request", (p) => mcpApproval(p, ask, s));
  // Codex's own question card and permission prompts: nobody can answer them headless.
  c.rpc.onRequest("item/tool/requestUserInput", () => Promise.reject(new Error(NO_CARD)));
  c.rpc.onRequest("item/permissions/requestApproval", () => Promise.reject(new Error("Not allowed by ion")));
}

// ---- the turn ---------------------------------------------------------------------------------------------

type Status = "done" | "interrupted" | "failed";
type Run = {
  c: Connection;
  opts: StartOpts;
  state: CodexState;
  emit: (e: AdapterEvent) => void;
  finish: (status: Status, failure?: Failure) => void;
  finished: boolean;
  interrupted: boolean;
  turnId: string | null;
  /** How the turn ends, once Codex said it completed (set while its windows are read). */
  ending?: () => void;
};

/** The run's state, and how it ends: an error if any, the turn's tokens, then exactly one run.finished. */
function createRun(c: Connection, opts: StartOpts, events: EventQueue<AdapterEvent>): Run {
  const r: Run = {
    c,
    opts,
    state: createCodexState(projectRoots(opts.cwd)),
    emit: () => {},
    finish: () => {},
    finished: false,
    interrupted: false,
    turnId: null,
  };
  r.emit = batching(
    (e) => events.push(e),
    () => r.finished,
  );
  r.finish = (status, failure) => {
    if (r.finished) return;
    if (failure) r.emit({ type: EV.error, data: failure });
    const usage = r.state.usage;
    const windows = r.state.windows ? { windows: r.state.windows } : {};
    if (usage)
      r.emit({ type: EV.usageReported, data: { model: c.model, ...usage, costUsd: null, ...windows } });
    r.emit({ type: EV.runFinished, data: { status } });
    r.finished = true;
    events.end();
    setTimeout(() => c.child.kill(), 100).unref();
  };
  return r;
}

/** How long the turn's end waits for Codex's windows. */
const WINDOWS_WAIT_MS = 3000;

/**
 * Codex's plan windows at the turn's end (`account/rateLimits/read`: no model call), into the run's state; nothing
 * when it doesn't answer in time or doesn't know the method (then the run reports no gauge).
 */
async function readWindows(r: Run): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), WINDOWS_WAIT_MS);
  });
  const read = r.c.rpc.request("account/rateLimits/read", {}).then(
    (res) => windowsOf((res as { rateLimits?: unknown }).rateLimits),
    () => null,
  );
  const windows = await Promise.race([read, late]);
  clearTimeout(timer);
  if (windows) r.state.windows = windows;
}

/** Ends the run as stopped when ion asked for that, else as failed. */
const endWith = (r: Run, failure: Failure) =>
  r.interrupted ? r.finish("interrupted") : r.finish("failed", failure);

function watch(r: Run): void {
  const { c, state } = r;
  for (const method of NOTIFICATIONS)
    c.rpc.onNotification(method, (p) => {
      for (const e of mapNotification(method, p, state)) r.emit(e);
    });
  c.rpc.onNotification("turn/completed", (p) => {
    const turn = (p.turn ?? {}) as { status?: unknown; error?: TurnError | null };
    // How it ended is known now; reading its windows first mustn't turn it into a crash if Codex exits meanwhile.
    r.ending = () => {
      if (turn.status === "completed") return r.finish("done");
      if (turn.status === "interrupted") return r.finish("interrupted");
      r.finish("failed", failureOf(turn.error ?? state.error, state.windows));
    };
    void readWindows(r).then(() => r.ending?.());
  });
  answerRequests(c, r.opts, state, r.emit);
  c.child.on("exit", () => (r.ending ? r.ending() : endWith(r, CRASH)));
  r.opts.signal.addEventListener("abort", () => c.child.kill());
}

function startTurn(r: Run, text: string): void {
  const { c, opts } = r;
  const started = { harness: "codex", model: c.model, effort: opts.effort, authMethod: c.authMethod };
  r.emit({ type: EV.runStarted, data: { ...started, sessionId: c.threadId } });
  const effort = effortOf(opts.effort);
  const input = [{ type: "text", text, text_elements: [] }];
  c.rpc
    .request("turn/start", { threadId: c.threadId, input, ...(effort ? { effort } : {}) })
    .then((res) => {
      r.turnId = String(((res as { turn?: { id?: unknown } }).turn ?? {}).id);
    })
    .catch((e: Error) =>
      endWith(r, e instanceof RpcError ? { code: "agent", retryable: false, message: e.message } : CRASH),
    );
}

/** One Codex turn mapped to ion events. Codex's app-server lives as long as the turn. */
export function startCodexSession(c: Connection, opts: StartOpts): Session {
  const events = createEventQueue<AdapterEvent>();
  const r = createRun(c, opts, events);
  watch(r);
  return {
    id: randomUUID(),
    nativeId: c.threadId,
    send: async ({ text }) => startTurn(r, text),
    events: () => events,
    async interrupt() {
      r.interrupted = true;
      if (r.turnId)
        c.rpc.request("turn/interrupt", { threadId: c.threadId, turnId: r.turnId }).catch(() => {});
      setTimeout(() => c.child.kill(), 3000).unref();
    },
    async close() {
      if (!r.finished) c.child.kill();
    },
  };
}
