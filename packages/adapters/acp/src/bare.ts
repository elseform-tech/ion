import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { agentEnv, type Rpc, sandboxed, withPaths } from "@ion/adapter-kit";
import {
  type AgentCaps,
  type Connection,
  type ConnectOpts,
  initialize,
  inTime,
  openSession,
  type Spawned,
  spawnAgent,
  startError,
} from "./connection.js";
import type { AcpHarness } from "./harnesses.js";

/**
 * Where a bare start's gate points (final review, 2026-11-22): an address nothing answers, so ion's gate hook (Grok's,
 * opencode's plugin) fails, and a failed gate refuses the call. Every tool the judge tries is refused.
 */
export const REFUSE_ALL = "http://127.0.0.1:0/ion-refuses-every-tool";

/** A warm agent is stopped after this long with no verdict. */
const IDLE_MS = 10 * 60_000;

type Json = Record<string, unknown>;
/** One session's handlers on the shared process, by method. */
type Routes = {
  notes: Map<string, (p: Json) => void>;
  asks: Map<string, (p: Json) => Promise<unknown>>;
  child: SessionChild;
};
type Warm = { ready: Promise<Spawned & { caps: AgentCaps }>; routes: Map<string, Routes>; idle?: NodeJS.Timeout };

/** ion's warm judges: one agent process per harness, folder, sandbox and env. */
const warm = new Map<string, Warm>();

/** Stops every warm agent (tests; the daemon's end stops them with it). */
export function closeWarm(): void {
  for (const [key, w] of warm) {
    warm.delete(key);
    void w.ready.then((a) => a.child.kill()).catch(() => {});
  }
}

/** One session of a warm agent, as a process to the session code: killing it ends the session, not the agent. */
class SessionChild extends EventEmitter {
  private done = false;
  constructor(private readonly end: () => void) {
    super();
  }
  kill(): boolean {
    if (this.done) return true;
    this.done = true;
    this.end();
    this.emit("exit");
    return true;
  }
  /** The real process went away: the session ends as a crash. */
  gone(): void {
    if (this.done) return;
    this.done = true;
    this.emit("exit");
  }
}

/**
 * A bare session (ion's judge) on a warm agent (final review, 2026-11-22: spawning the agent and starting its server
 * for every verdict made Grok's judge time out): the agent for this harness, folder, sandbox and env, started once,
 * and a fresh session in it per verdict. Its end closes the session and has the agent forget it.
 */
export async function bareConnect(h: AcpHarness, bin: string, o: ConnectOpts): Promise<Connection> {
  const key = JSON.stringify([h.id, bin, o.cwd, o.args ?? null, o.sandbox ?? null, o.envDrop ?? null]);
  let w = warm.get(key);
  if (!w) {
    w = warmUp(h, bin, o, key);
    warm.set(key, w);
  }
  clearTimeout(w.idle);
  try {
    const a = await w.ready;
    const s = await inTime(h, o, openSession(h, a.rpc, a.caps, { ...o, resume: null }));
    const child = new SessionChild(() => endSession(h, bin, o, { w: w!, a, sessionId: s.sessionId }));
    w.routes.set(s.sessionId, { notes: new Map(), asks: new Map(), child });
    const rpc = routed(a.rpc, w.routes.get(s.sessionId)!);
    return { child, rpc, ...s, ...(a.failure ? { failure: a.failure } : {}) };
  } catch (e) {
    if (warm.get(key) === w && !w.routes.size) stop(key, w);
    throw startError(h, o, e);
  }
}

/** Starts the agent and routes its session updates and permission asks to the session they're for. */
function warmUp(h: AcpHarness, bin: string, o: ConnectOpts, key: string): Warm {
  const routes = new Map<string, Routes>();
  const a = spawnAgent(h, bin, o);
  a.child.on("exit", () => {
    if (warm.get(key)?.routes === routes) warm.delete(key);
    for (const r of routes.values()) r.child.gone();
  });
  const of = (p: Json) => routes.get(String(p.sessionId ?? ""));
  a.rpc.onNotification("session/update", (p) => of(p)?.notes.get("session/update")?.(p));
  a.rpc.onRequest("session/request_permission", async (p) => {
    const ask = of(p)?.asks.get("session/request_permission");
    return ask ? ask(p) : { outcome: { outcome: "cancelled" } };
  });
  const ready = inTime(h, o, initialize(a.rpc)).then(
    (caps) => ({ ...a, caps }),
    (e: unknown) => {
      a.child.kill();
      throw e;
    },
  );
  return { ready, routes };
}

/** The shared JSON-RPC as one session sees it: its handlers are its own. */
function routed(rpc: Rpc, r: Routes): Rpc {
  return {
    request: (m, p) => rpc.request(m, p),
    notify: (m, p) => rpc.notify(m, p),
    onRequest: (m, handler) => void r.asks.set(m, handler),
    onNotification: (m, handler) => void r.notes.set(m, handler),
  };
}

/** A verdict's session ends: cancelled if still going, closed where the agent can, forgotten; the agent waits idle. */
function endSession(
  h: AcpHarness,
  bin: string,
  o: ConnectOpts,
  s: { w: Warm; a: Spawned & { caps: AgentCaps }; sessionId: string },
): void {
  const { w, a, sessionId } = s;
  w.routes.delete(sessionId);
  a.rpc.notify("session/cancel", { sessionId });
  const closing = a.caps.sessionCapabilities?.close
    ? a.rpc.request("session/close", { sessionId }).catch(() => {})
    : Promise.resolve();
  void closing.then(() => forget(h, bin, o, sessionId));
  if (!w.routes.size) {
    w.idle = setTimeout(() => {
      for (const [key, x] of warm) if (x === w) stop(key, w);
    }, IDLE_MS);
    w.idle.unref();
  }
}

function stop(key: string, w: Warm): void {
  warm.delete(key);
  void w.ready.then((a) => a.child.kill()).catch(() => {});
}

/**
 * Has the agent delete a judge's session from its history (Grok: `grok sessions delete`; opencode: `opencode session
 * delete`), so ion's verdicts don't pile up among your own sessions. In the same sandbox; its failure changes nothing.
 */
function forget(h: AcpHarness, bin: string, o: ConnectOpts, sessionId: string): void {
  const args = h.forgetArgs?.(sessionId);
  if (!args) return;
  const run = sandboxed(withPaths(o.sandbox, h.sandboxPaths?.() ?? {}), bin, args);
  const env = { ...agentEnv(process.env, o.envDrop), ...o.env };
  const child = spawn(run.command, run.args, { stdio: "ignore", env, cwd: o.cwd });
  child.on("error", () => {});
  child.unref();
}
