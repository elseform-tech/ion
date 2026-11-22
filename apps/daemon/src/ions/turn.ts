import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type ApprovalRequest,
  type HarnessAdapter,
  ION_SERVER,
  projectRoots,
  type Session,
  type StartOpts,
} from "@ion/adapter-kit";
import { DEFAULT_PROJECT, loadUserConfig } from "@ion/config";
import { EV, type HarnessInfo } from "@ion/schema";
import { ionDirsOf } from "../access/index.js";
import type { RuleCtx } from "../access/rules.js";
import { getHarness } from "../adapters/registry.js";
import { UserError } from "../api/errors.js";
import type { GateAnswer } from "../gate/index.js";
import type { Grants, IonScope } from "../mcp/index.js";
import type { Db, EventStore } from "../store/index.js";
import { type IonBrain, ionBrain, limitedUntil, nextBrain } from "./brain.js";
import { forgetSession, type Kept, keepSession, resumeOf, startSession } from "./sessions.js";
import { errLine, NO_AGENT, noAgent, onReadyAgents, STOPPED, TOO_LONG, type Tried } from "./fallback.js";
import { ionVerdict } from "./gate.js";
import { ionInstructions } from "./instructions.js";
import { ionIndex, type MemoryFiles } from "../memory/index.js";
import { ownAgentStart } from "../access/runner.js";
import { type Net, systemNet } from "../secrets/oauth-net.js";
import { type TurnWeb, WebFound } from "./web.js";
import { type IonGateCall as GateCall, IonServers } from "./servers.js";
import { DREAM_ION } from "../memory/dream-rules.js";
import { DREAM_SKIPPED, dreamVerdict } from "./dream.js";
import type { DreamPass } from "../memory/dream-rules.js";
import { CLOSE_MS, closing, type Ended, note } from "./turn-end.js";
import { ledgerEvent } from "../views/usage.js";
import type { Verdict } from "./web.js";

/** A turn's hard limit: past it the agent is stopped and the ion says it couldn't finish. */
const ION_TURN_MS = 300_000;
/** What one turn may do at most: write memory, start threads (ion's tools and the ions both count). */
export const PER_TURN = 5;
export { NO_AGENT, noAgent, STOPPED, TOO_LONG } from "./fallback.js";

/** What of a turn's session is kept on the ion's chat, so the app can draw its work. */
const KEPT: ReadonlySet<string> = new Set([EV.toolStarted, EV.toolFinished, EV.thinkingDelta]);

type Thread = { chatId: string; projectId: string };
/** Skills and servers a thread starts with, by name ("/" and "@"; the user, 2026-11-21). */
type Picks = { skills?: string[]; mentions?: string[] };
type TurnRef = { ionId: string; turnId: string };

/**
 * Starts a thread for an ion's turn: its chat, or why it couldn't. `turn.request` is your own message (what the
 * judge reads as your request), never the brief the ion's agent wrote.
 */
type StartIonThread = (
  projectId: string,
  brief: string,
  turn: { ionId: string; request: string; turnId: string },
  picks?: Picks,
) => Promise<{ chatId: string } | { why: string }>;

/**
 * How a turn may act: `request`: your own words, what the judge reads for a thread it starts (by default the
 * turn's text); `noThreads`: a turn the daemon asked for (a report) starts none, and has no request of yours.
 */
export type TurnOpts = { request?: string; noThreads?: true; dream?: DreamTurn };

/** One pass of ion's dream: which files it sees and changes, how many changes are left, and how long it has. */
export type DreamTurn = { pass: DreamPass; max: number; ms: number };

/**
 * A turn's reply and the threads it started; `turnId`: the turn whose work its chat keeps (none when no session
 * started), which its reply carries so the app puts that work above it.
 */
export type TurnResult = { reply: string; threads: Thread[]; turnId?: string };

export type IonTurnsDeps = {
  store: EventStore;
  db: Db;
  configFile: string;
  /** ion's data folder: ion chief thinks in an empty folder there, and an ion may never read it. */
  dataDir: string;
  grants: Grants;
  mcpUrl: () => string;
  gateUrl: () => string;
  agents: () => Promise<HarnessInfo[]>;
  /** One agent, asked alone (an ion whose agent is chosen checks only that one). */
  agent?: (id: string) => Promise<HarnessInfo | undefined>;
  startThread: StartIonThread;
  /** The turn's hard limit (tests make it short). */
  turnMs?: number;
  home?: string;
  /** How a page's host is looked up before an ion reads it (tests give their own). */
  dns?: Net["dns"];
  /** Your servers for ions' turns, through ion's gateway (only what reads; the user, 2026-11-21). */
  servers?: IonServers;
  /** ion's memory: each turn starts with the index of what that ion may see. */
  memory?: MemoryFiles;
};

/** A turn while it runs: what its tools and its gate need, and how to stop it (set once its session starts). */
type Live = {
  ionId: string;
  /** Your words, for the judge; null: this turn starts no threads. */
  request: string | null;
  /** ion's dream's pass (its tools, its limits). */
  dream?: DreamTurn;
  adapter: HarnessAdapter;
  rules: RuleCtx;
  /** The addresses this turn found (your message's, its searches' results): the only pages it may read. */
  web: WebFound;
  threads: Thread[];
  /** Ends the turn now: past its limit or ion stopping, or `stopped`: you stopped it. */
  halt?: (stopped?: true) => void;
};

/** ion's own server for a turn, with the turn's key. */
const ionSpec = ({ url, key }: { url: string; key: string }) =>
  ({ name: ION_SERVER, transport: "http", url, headers: { Authorization: `Bearer ${key}` } }) as const;

/**
 * One ion's turn is a real agent session: on its agent, model and effort, in its folder, with ion's tools for the
 * projects it may see (a key per turn) and a gate that only lets it read. Its last message is the reply; the
 * threads it started come with it. Each ion keeps its session between turns, and thinks one turn at a time.
 */
export class IonTurns {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly live = new Map<string, Live>();
  /** Turns asked for and not yet over, per ion (its own and those waiting behind it). */
  private readonly pending = new Map<string, number>();
  /**
   * Ions whose current turn is starting (finding its agent, its session not yet up: nothing to halt yet), and
   * whether that turn answers your message (a report doesn't).
   */
  private readonly starting = new Map<string, boolean>();
  /** You stopped an ion's turn while it was starting: it ends as stopped as soon as it can. */
  private readonly stopAsked = new Set<string>();
  /** ion is stopping: no turn starts, and nothing more is written. */
  private stopping = false;

  /** The memory index each ion's session was last given (M-5: a resumed one gets it again only when it changed). */
  private readonly sentIndex = new Map<string, string>();
  /** Your servers for its turns (none when the daemon gives none). */
  private readonly servers: IonServers;

  constructor(private readonly d: IonTurnsDeps) {
    this.servers = d.servers ?? new IonServers({ configFile: d.configFile, dataDir: d.dataDir });
  }

  /** Your message to an ion: waits for its turn before (one session per ion at a time), then thinks. */
  turn(ionId: string, text: string, o: TurnOpts = {}): Promise<TurnResult> {
    const next = (this.chains.get(ionId) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.run(ionId, text, o));
    this.chains.set(ionId, next);
    this.pending.set(ionId, (this.pending.get(ionId) ?? 0) + 1);
    // Counted down before whoever awaits the turn hears it's over.
    const over = () => {
      const n = (this.pending.get(ionId) ?? 1) - 1;
      if (n > 0) this.pending.set(ionId, n);
      else this.pending.delete(ionId);
    };
    next.then(over, over);
    return next;
  }

  /** Whether the ion is thinking (a turn going, or waiting for one). */
  busy(ionId: string): boolean {
    return this.pending.has(ionId);
  }

  /**
   * You stopped the ion's turn (Esc twice): it ends now and says so; its next turn goes on. Only a turn answering
   * your message stops: a report on a thread goes on. False: none was going.
   */
  stop(ionId: string): boolean {
    const going = [...this.live.values()].filter((t) => t.ionId === ionId && t.halt && t.request !== null);
    for (const t of going) t.halt!(true);
    if (going.length) return true;
    // Still starting: only this turn ends, never one waiting behind it.
    if (!this.starting.get(ionId)) return false;
    this.stopAsked.add(ionId);
    return true;
  }

  /** start_thread for a live turn (ion's MCP server): the thread joins the turn's reply. */
  readonly startThread = async (projectId: string, brief: string, turnId: string, picks?: Picks) => {
    const t = this.live.get(turnId);
    if (!t) return { why: "That turn is over" };
    if (t.request === null) return { why: "Not in a report" };
    const turn = { ionId: t.ionId, request: t.request, turnId };
    const r = await this.d.startThread(projectId, brief, turn, picks);
    if ("chatId" in r) t.threads.push({ chatId: r.chatId, projectId });
    return r;
  };

  /** A tool call a turn's hook reported (its gate key's turn); null when the harness's payload isn't one. */
  async gate(scope: IonScope, payload: unknown): Promise<GateAnswer | null> {
    const t = this.live.get(scope.turnId);
    const call = t?.adapter.gateCall?.(payload);
    if (!t || !call) return null;
    const req = { requestId: "gate", toolId: "gate", ...call };
    return this.verdict(t, req, scope.turnId);
  }

  /** ion's gate for a live turn's call: an ion only reads; its dream only uses memory's tools. */
  private verdict(t: Live, req: ApprovalRequest, turnId: string): Promise<Verdict> {
    if (t.ionId === DREAM_ION) return Promise.resolve(dreamVerdict(req));
    return ionVerdict(req, t.rules, this.webOf(t), this.servers.of(turnId));
  }

  /** ion's gate for an ion's call on one of your servers (ion's gateway asks): only what reads, and only yours. */
  async gateMcp(turnId: string, call: GateCall): Promise<GateAnswer> {
    return this.servers.gate(turnId, call, this.live.get(turnId)?.request);
  }

  /** What a live turn may read on the web. */
  private webOf(t: Live): TurnWeb {
    return { found: t.web.found, dns: this.d.dns ?? systemNet.dns };
  }

  /** Stops every live turn (its agent told to stop, its session closed) and waits for them; none starts after. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const t of this.live.values()) t.halt?.();
    // A live turn ends at once and closes within CLOSE_MS; one still finding its agent writes nothing once it does.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((r) => {
      timer = setTimeout(r, CLOSE_MS + 500);
    });
    await Promise.race([Promise.allSettled([...this.chains.values()]), bound]);
    clearTimeout(timer);
  }

  private async run(ionId: string, text: string, o: TurnOpts): Promise<TurnResult> {
    if (this.stopping) return { reply: NO_AGENT, threads: [] };
    const request = o.noThreads ? null : (o.request ?? text);
    this.starting.set(ionId, request !== null);
    try {
      return await this.think(ionId, text, { request, ...(o.dream ? { dream: o.dream } : {}) });
    } finally {
      this.starting.delete(ionId);
      this.stopAsked.delete(ionId);
    }
  }

  /**
   * A turn on the ion's agent; one that fails before it says or starts anything goes on to the next ready agent (the
   * order ion picks in), and its reply says so in one line (Plan 19's checks, 2026-11-22: a project's ion failed on
   * its agent and said only "I couldn't reach my agent"). A dream keeps its own agent.
   */
  private async think(ionId: string, text: string, o: Pick<Live, "request" | "dream">): Promise<TurnResult> {
    const cwd = this.folderOf(ionId);
    const brain = await ionBrain(this.d, ionId).catch(() => null);
    if (this.stopAsked.delete(ionId)) return { reply: STOPPED, threads: [] };
    if (!brain) return { reply: NO_AGENT, threads: [] };
    // Every try is one turn (security review, 2026-11-22): its id, and so its caps on memory and threads.
    const turnId = `turn_${randomUUID()}`;
    const r = await onReadyAgents(brain, {
      once: (b) => this.once(ionId, text, { ...o, cwd, turnId }, b),
      next: (not) => nextBrain(this.d, ionId, not),
      limitedUntil: (h) => limitedUntil(this.d.db, h),
      stay: (x: TurnResult) => !!x.threads.length || !!o.dream || this.stopping,
    });
    return o.dream && noAgent(r.reply) ? { ...r, reply: NO_AGENT } : r;
  }

  /** One try of a turn on this agent; `failed` when it said nothing (why: its agent's own words, when it said). */
  private async once(
    ionId: string,
    text: string,
    o: Pick<Live, "request" | "dream"> & { cwd: string; turnId: string },
    brain: IonBrain,
  ): Promise<Tried<TurnResult>> {
    const { request, cwd, turnId } = o;
    const h = getHarness(brain.harness);
    if (!h || this.stopping) return { reply: NO_AGENT, threads: [] };
    // A dream never searches the web (task review, 2026-11-22): on an agent that can't turn its web off, none.
    if (o.dream && !h.adapter.noWeb)
      return { reply: `${DREAM_SKIPPED} ${h.label} can't turn its web off`, threads: [] };
    const rules = this.rulesFor(cwd);
    // Only your own words seed what it may read: a report's prompt is an agent's.
    const live: Live = { ionId, request, adapter: h.adapter, rules, web: new WebFound(request), threads: [] };
    if (o.dream) live.dream = o.dream;
    this.live.set(turnId, live);
    try {
      const t = { ionId, turnId, text, cwd, rules, report: request === null, dream: o.dream };
      const { end, projects } = await this.session(t, brain, h.adapter);
      const reply = this.settle(ionId, { harness: brain.harness, projects }, end);
      if (reply !== NO_AGENT || this.stopping) return { reply, threads: live.threads, turnId };
      // Said once in ion's log: why the agent failed (Plan 19's checks, 2026-11-22: nothing was).
      console.error(`ion's agent (${brain.harness}): ${end.error ?? "it said nothing"}`);
      return {
        reply,
        threads: live.threads,
        turnId,
        failed: { why: end.error ?? null, did: this.did(turnId) },
      };
    } catch (e) {
      console.error(`ion's agent (${brain.harness}): ${errLine(e)}`);
      if (!this.stopping) forgetSession(this.d, ionId);
      return {
        reply: NO_AGENT,
        threads: live.threads,
        turnId,
        ...(this.stopping ? {} : { failed: { why: null, did: this.did(turnId) } }),
      };
    } finally {
      this.live.delete(turnId);
      this.d.grants.revoke(turnId);
      await this.servers.close(turnId);
    }
  }

  /** Whether this try wrote memory or started a thread: a try that did isn't tried again. */
  private did(turnId: string): boolean {
    return this.d.grants.used(turnId) || !!this.live.get(turnId)?.threads.length;
  }

  /** A turn's reply from how its session ended; its session kept for the next turn, or forgotten when broken. */
  private settle(ionId: string, kept: Omit<Kept, "nativeId">, end: Ended): string {
    if (this.stopping) return NO_AGENT;
    if (end.stopped) return this.stoppedReply(ionId, kept, end);
    const reply = end.late ? TOO_LONG : end.last.trim() || NO_AGENT;
    // A session that failed or said nothing is forgotten: resuming it would likely fail again (its context too long).
    // One that didn't close is too: the agent may still hold it, and two sessions would resume one id.
    const broken = end.stuck || (!end.late && (end.failed || reply === NO_AGENT));
    if (broken) forgetSession(this.d, ionId);
    else if (end.nativeId) keepSession(this.d, ionId, { ...kept, nativeId: end.nativeId });
    return reply;
  }

  /** A turn you stopped: its session kept if it closed (resuming it is fine), else forgotten. */
  private stoppedReply(ionId: string, kept: Omit<Kept, "nativeId">, end: Ended): string {
    if (end.stuck) forgetSession(this.d, ionId);
    else if (end.nativeId) keepSession(this.d, ionId, { ...kept, nativeId: end.nativeId });
    return STOPPED;
  }

  /** ion chief (and its dream): an empty folder of its own (made now); a project's ion: its project's folder. */
  private folderOf(ionId: string): string {
    if (ionId !== "chief" && ionId !== DREAM_ION) {
      const p = loadUserConfig(this.d.configFile).config.projects.find((x) => x.id === ionId);
      if (!p || ionId === DEFAULT_PROJECT) throw new UserError(`Unknown ion: ${ionId}`);
      return p.path;
    }
    const dir = join(this.d.dataDir, "ions", ionId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private rulesFor(cwd: string): RuleCtx {
    return ionRules(this.d, cwd);
  }

  /**
   * The projects an ion's tools may see (sorted): ion chief those shared with it, a project's ion its own. A report
   * turn's key says so: its tools write nothing.
   */
  private scopeOf(t: TurnRef & { report: boolean; dream?: DreamTurn }): IonScope {
    const all = loadUserConfig(this.d.configFile).config.projects.filter((p) => p.id !== DEFAULT_PROJECT);
    const projects =
      t.ionId === "chief" || t.ionId === DREAM_ION
        ? all
            .filter((p) => p.shareWithIon !== false)
            .map((p) => p.id)
            .sort()
        : [t.ionId];
    const dream = t.dream ? { dream: { ...t.dream.pass, max: t.dream.max } } : {};
    return {
      kind: "ion",
      ionId: t.ionId,
      projects,
      turnId: t.turnId,
      ...(t.report ? { report: true } : {}),
      ...dream,
    };
  }

  /**
   * Starts (or resumes) the ion's session with its keys, sends your message, and reads it to its end or limit; how
   * it ended, and the projects it saw.
   */
  private async session(
    t: TurnRef & { text: string; cwd: string; rules: RuleCtx; report: boolean; dream?: DreamTurn },
    brain: IonBrain,
    adapter: HarnessAdapter,
  ): Promise<{ end: Ended; projects: string[] }> {
    const scope = this.scopeOf(t);
    const mcpKey = this.d.grants.create(scope);
    const gateKey = adapter.gateCall ? this.d.grants.create(scope, "gate") : null;
    const abort = new AbortController();
    // Your servers that are on, at ion's URL for each with only the turn's key (a report's turn gets none).
    const ion = { url: this.d.mcpUrl(), key: mcpKey };
    const yours = await this.servers.forTurn(t.turnId, ion, adapter, t.report || t.ionId === DREAM_ION);
    const opts: StartOpts = {
      cwd: t.cwd,
      model: brain.model,
      effort: brain.effort,
      instructions: ionInstructions(t.ionId),
      // ion's server first, then yours through ion's gateway (ion decides each call there: only what reads).
      mcpServers: [ionSpec(ion), ...yours],
      ...(gateKey ? { gate: { url: `${this.d.gateUrl()}/${gateKey}` } } : {}),
      // ion's own agents don't inherit your keys either, and start in a run's sandbox (final review, 2026-11-22).
      ...(await ownAgentStart(this.d, t.cwd, brain.harness)),
      ...(t.dream ? { noWeb: true, bareHome: this.ownFolder() } : {}),
      signal: abort.signal,
      decide: async (req: ApprovalRequest) => {
        const live = this.live.get(t.turnId);
        return live ? (await this.verdict(live, req, t.turnId)).decision : "deny";
      },
    };
    const resume = resumeOf(this.d.db, t.ionId, brain.harness, scope.projects);
    const end = await this.within(abort, t.turnId, (e, hold) =>
      this.drive({ ...t, scope, adapter, opts, resume }, e, hold),
    );
    return { end, projects: scope.projects };
  }

  /**
   * Runs a turn's work under its hard limit: past it the agent is told to stop (its signal, its session interrupted)
   * and ion doesn't wait for it, even if it doesn't stop.
   */
  private async within(
    abort: AbortController,
    turnId: string,
    work: (end: Ended, hold: (s: Session) => void) => Promise<void>,
  ): Promise<Ended> {
    const end: Ended = { last: "", nativeId: null, late: false, failed: false };
    let session: Session | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((r) => {
      const stop = (stopped?: true) => {
        clearTimeout(timer);
        end.late = true;
        if (stopped) end.stopped = true;
        abort.abort();
        void session?.interrupt().catch(() => {});
        r();
      };
      timer = setTimeout(() => stop(), this.d.turnMs ?? this.limitOf(turnId));
      // ion stopping ends the turn as its limit would.
      const live = this.live.get(turnId);
      if (live) {
        live.halt = stop;
        this.starting.delete(live.ionId);
        if (this.stopAsked.delete(live.ionId)) stop(true);
      }
      if (this.stopping) stop();
    });
    // A session that starts after the limit is closed as soon as it does.
    const hold = (s: Session) => {
      session = s;
      if (end.late) void s.close().catch(() => {});
    };
    const done = work(end, hold);
    done.catch(() => {});
    try {
      await Promise.race([done, late]);
      return end;
    } finally {
      clearTimeout(timer);
      if (session && !(await closing(session))) end.stuck = true;
    }
  }

  /** A turn's hard limit: a dream's pass has what's left of its 10 minutes. */
  private limitOf(turnId: string): number {
    return this.live.get(turnId)?.dream?.ms ?? ION_TURN_MS;
  }

  /** A daemon-only folder for the dream's agent's own files (Grok's profile), which it may only read. */
  private ownFolder(): string {
    const dir = join(this.d.dataDir, "ions", `${DREAM_ION}-own`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** Starts (or resumes) the session, sends your message, and reads the session to its end. */
  private async drive(
    t: TurnRef & { text: string; scope: IonScope; adapter: HarnessAdapter; opts: StartOpts; resume?: string },
    end: Ended,
    hold: (s: Session) => void,
  ): Promise<void> {
    const { session, resumed } = await startSession(t.adapter, t.opts, t.resume);
    hold(session);
    end.nativeId = session.nativeId;
    if (end.late) return;
    // A dream's message holds the whole index already.
    const index =
      t.ionId === DREAM_ION ? "" : ionIndex(this.d.memory, t.scope, { resumed, sent: this.sentIndex });
    await session.send({ text: index + t.text });
    await this.pump(session, t, end);
  }

  /** Keeps the turn's work on the ion's chat (until its limit), its last message, and its native session id. */
  private async pump(session: Session, t: TurnRef & { adapter: HarnessAdapter }, end: Ended): Promise<void> {
    for await (const e of session.events()) {
      if (end.late) return;
      if (KEPT.has(e.type) && t.ionId !== DREAM_ION)
        this.d.store.append({ ...e, chatId: `ion:${t.ionId}`, runId: t.turnId, origin: "adapter" });
      this.live.get(t.turnId)?.web.note(e);
      // What the turn spends, and a limit it hits, go in its agent's usage (never on the ion's chat).
      const kept = ledgerEvent(t.adapter.id, e, t.turnId);
      if (kept) this.d.store.append(kept);
      note(e, end);
    }
  }
}

/** What an ion may read: its folder (a project's repo), never your secrets or ion's own files. */
export function ionRules(d: { dataDir: string; configFile: string; home?: string }, cwd: string): RuleCtx {
  return {
    roots: projectRoots(cwd),
    home: d.home ?? homedir(),
    ionDirs: ionDirsOf(d),
  };
}
