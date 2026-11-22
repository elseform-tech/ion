import { EventEmitter } from "node:events";
import type { Rpc } from "@ion/adapter-kit";
import {
  type AgentCaps,
  type Connection,
  type ConnectOpts,
  forget,
  type GiveUp,
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
type Warm = {
  ready: Promise<Spawned & { caps: AgentCaps }>;
  routes: Map<string, Routes>;
  idle?: NodeJS.Timeout;
};

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
  kill(): void {
    if (this.done) return;
    this.done = true;
    this.end();
    this.emit("exit");
  }
  /** The real process went away: the session ends as a crash. */
  gone(): void {
    if (this.done) return;
    this.done = true;
    this.emit("exit");
  }
}

/**
 * A bare session (ion's judge) on a warm agent, in its own folder (final review, 2026-11-22: spawning the agent and starting its server
 * for every verdict made Grok's judge time out): the agent for this harness, sandbox and env, started once,
 * and a fresh session in it per verdict. Its end closes the session and has the agent forget it.
 */
export async function bareConnect(h: AcpHarness, bin: string, o: ConnectOpts): Promise<Connection> {
  // Not its folder: each verdict's session opens in a folder of its own (PR #25 review, 2026-11-22).
  const key = JSON.stringify([h.id, bin, o.args ?? null, o.sandbox ?? null, o.envDrop ?? null]);
  let w = warm.get(key);
  if (!w) {
    w = warmUp(h, bin, o, key);
    warm.set(key, w);
  }
  clearTimeout(w.idle);
  try {
    const a = await w.ready;
    const s = await inTime(h, o, openSession(h, a.rpc, a.caps, { ...o, resume: null }));
    const log = a.giveUp && ownGiveUp(a.giveUp, s.sessionId);
    const child = new SessionChild(() => {
      log?.off();
      endSession(h, bin, o, { w: w!, a, sessionId: s.sessionId });
    });
    w.routes.set(s.sessionId, { notes: new Map(), asks: new Map(), child });
    const rpc = routed(a.rpc, w.routes.get(s.sessionId)!);
    const giveUp = log ? { giveUp: log.giveUp } : {};
    return { child, rpc, ...s, ...(a.failure ? { failure: a.failure } : {}), ...giveUp };
  } catch (e) {
    if (warm.get(key) === w && !w.routes.size) stop(key, w);
    throw startError(h, o, e);
  }
}

/**
 * The shared log's lines saying the agent can't go on, as one session hears them: its own, and those that name no
 * session (Judge eval, 2026-11-22: opencode out of quota says so once per session), until the session ends.
 */
function ownGiveUp(all: GiveUp, sessionId: string): { giveUp: GiveUp; off: () => void } {
  const offs: (() => void)[] = [];
  const giveUp: GiveUp = (l) => {
    const off = all((why, id) => (id === undefined || id === sessionId ? l(why, id) : undefined));
    offs.push(off);
    return off;
  };
  // Its end stops its listening: the warm agent's log outlives it.
  return { giveUp, off: () => offs.splice(0).forEach((off) => off()) };
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
