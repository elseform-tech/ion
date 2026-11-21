import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AdapterEvent,
  type ApprovalRequest,
  type GateCall,
  type HarnessAdapter,
  ION_SERVER,
  projectRoots,
  ResumeFailed,
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
import { ionsView } from "../views/ions.js";
import { type IonBrain, ionBrain } from "./brain.js";
import { ionVerdict } from "./gate.js";
import { ionInstructions } from "./instructions.js";
import { envDropOf } from "../tools/env-drop.js";
import { type Net, systemNet } from "../secrets/oauth-net.js";
import { type TurnWeb, WebFound } from "./web.js";
import type { ThreadPicks } from "../mcp/ion-tools.js";
import type { IonServers } from "./servers.js";

/** A turn's hard limit: past it the agent is stopped and the ion says it couldn't finish. */
const ION_TURN_MS = 300_000;
/** What one turn may do at most: write memory, start threads (ion's tools and the ions both count). */
export const PER_TURN = 5;
export const NO_AGENT = "I couldn't reach my agent; try again.";
export const TOO_LONG = "I couldn't finish that in time.";
/** What an ion says when you stopped its turn (Esc twice). */
export const STOPPED = "Stopped.";

/** What of a turn's session is kept on the ion's chat, so the app can draw its work. */
const KEPT: ReadonlySet<string> = new Set([EV.toolStarted, EV.toolFinished, EV.thinkingDelta]);

type Thread = { chatId: string; projectId: string };
type TurnRef = { ionId: string; turnId: string };
/** An ion's session as kept between its turns: its agent, its native id, and the projects its tools saw. */
type Kept = { harness: string; nativeId: string; projects: string[] };

/**
 * Starts a thread for an ion's turn: its chat, or why it couldn't. `turn.request` is your own message (what the
 * judge reads as your request), never the brief the ion's agent wrote.
 */
type StartIonThread = (
  projectId: string,
  brief: string,
  turn: { ionId: string; request: string; turnId: string },
  picks?: ThreadPicks,
) => Promise<{ chatId: string } | { why: string }>;

/**
 * How a turn may act: `request`: your own words, what the judge reads for a thread it starts (by default the
 * turn's text); `noThreads`: a turn the daemon asked for (a report) starts none, and has no request of yours.
 */
export type TurnOpts = { request?: string; noThreads?: true };

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
};

/** A turn while it runs: what its tools and its gate need, and how to stop it (set once its session starts). */
type Live = {
  ionId: string;
  /** Your words, for the judge; null: this turn starts no threads. */
  request: string | null;
  adapter: HarnessAdapter;
  rules: RuleCtx;
  /** The addresses this turn found (your message's, its searches' results): the only pages it may read. */
  web: WebFound;
  threads: Thread[];
  /** Your servers this turn reaches through ion's gateway (its agent's hook lets their calls on; ion decides there). */
  served: string[];
  /** Ends the turn now: past its limit or ion stopping, or `stopped`: you stopped it. */
  halt?: (stopped?: true) => void;
};

/**
 * How a turn's session ended: its last message, its native id, whether it ran past its limit, and `stuck`: it
 * didn't close in time (the agent may still hold it open).
 */
type Ended = {
  last: string;
  nativeId: string | null;
  late: boolean;
  failed: boolean;
  stuck?: true;
  /** You stopped it (it ended as `late` does, but says so). */
  stopped?: true;
};

/** How long ion waits for a session to close: an agent that never does can't hold the turn, nor the ion's next. */
const CLOSE_MS = 2000;

/** Closes a session, waiting at most CLOSE_MS: whether it closed in time. */
async function closing(session: Session): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = new Promise<false>((r) => {
    timer = setTimeout(() => r(false), CLOSE_MS);
  });
  try {
    return await Promise.race([
      session.close().then(
        () => true,
        () => true,
      ),
      wait,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Notes the session's last message, and its native id once the agent says it (some only say it when it starts). */
function note(e: AdapterEvent, end: Ended): void {
  if (e.type === EV.error) end.failed = true;
  if (e.type === EV.runFinished && (e.data as { status?: unknown }).status !== "done") end.failed = true;
  if (e.type === EV.messageCompleted) end.last = String((e.data as { text?: unknown }).text ?? "");
  const id = e.type === EV.runStarted ? (e.data as { sessionId?: unknown }).sessionId : undefined;
  if (typeof id === "string" && id) end.nativeId = id;
}

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

  constructor(private readonly d: IonTurnsDeps) {}

  /** Your message to an ion: waits for its turn before (one session per ion at a time), then thinks. */
  turn(ionId: string, text: string, o: TurnOpts = {}): Promise<TurnResult> {
    const next = (this.chains.get(ionId) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.run(ionId, text, o.noThreads ? null : (o.request ?? text)));
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
  readonly startThread = async (projectId: string, brief: string, turnId: string, picks?: ThreadPicks) => {
    const t = this.live.get(turnId);
    if (!t) return { why: "That turn is over" };
    if (t.request === null) return { why: "Not in a report" };
    const turn = { ionId: t.ionId, request: t.request, turnId };
    const r = picks
      ? await this.d.startThread(projectId, brief, turn, picks)
      : await this.d.startThread(projectId, brief, turn);
    if ("chatId" in r) t.threads.push({ chatId: r.chatId, projectId });
    return r;
  };

  /** A tool call a turn's hook reported (its gate key's turn); null when the harness's payload isn't one. */
  async gate(scope: IonScope, payload: unknown): Promise<GateAnswer | null> {
    const t = this.live.get(scope.turnId);
    const call = t?.adapter.gateCall?.(payload);
    if (!t || !call) return null;
    return ionVerdict({ requestId: "gate", toolId: "gate", ...call }, t.rules, this.webOf(t), t.served);
  }

  /** ion's gate for an ion's call on one of your servers (ion's gateway asks): only what reads, and only yours. */
  async gateMcp(turnId: string, call: GateCall): Promise<GateAnswer> {
    const t = this.live.get(turnId);
    if (!t || !this.d.servers) return { decision: "deny", reason: "That turn is over" };
    // A report's turn has no words of yours to judge by: it reads nothing of your servers.
    if (t.request === null) return { decision: "deny", reason: "Not in a report" };
    return this.d.servers.gate(turnId, call, t.request);
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

  private async run(ionId: string, text: string, request: string | null): Promise<TurnResult> {
    if (this.stopping) return { reply: NO_AGENT, threads: [] };
    this.starting.set(ionId, request !== null);
    try {
      return await this.think(ionId, text, request);
    } finally {
      this.starting.delete(ionId);
      this.stopAsked.delete(ionId);
    }
  }

  private async think(ionId: string, text: string, request: string | null): Promise<TurnResult> {
    const cwd = this.folderOf(ionId);
    const brain = await ionBrain(this.d, ionId).catch(() => null);
    if (this.stopAsked.delete(ionId)) return { reply: STOPPED, threads: [] };
    const h = brain && getHarness(brain.harness);
    if (!brain || !h || this.stopping) return { reply: NO_AGENT, threads: [] };
    const turnId = `turn_${randomUUID()}`;
    const rules = this.rulesFor(cwd);
    // Only your own words seed what it may read: a report's prompt is an agent's.
    const live: Live = {
      ...{ ionId, request, adapter: h.adapter, rules, web: new WebFound(request), threads: [] },
      served: [],
    };
    this.live.set(turnId, live);
    try {
      const t = { ionId, turnId, text, cwd, rules, report: request === null };
      const { end, projects } = await this.session(t, brain, h.adapter);
      return {
        reply: this.settle(ionId, { harness: brain.harness, projects }, end),
        threads: live.threads,
        turnId,
      };
    } catch (e) {
      console.error(`ion's agent (${brain.harness}): ${e instanceof Error ? e.name : "an error"}`);
      if (!this.stopping) this.forgetSession(ionId);
      return { reply: NO_AGENT, threads: live.threads, turnId };
    } finally {
      this.live.delete(turnId);
      this.d.grants.revoke(turnId);
      await this.d.servers?.close(turnId);
    }
  }

  /** A turn's reply from how its session ended; its session kept for the next turn, or forgotten when broken. */
  private settle(ionId: string, kept: Omit<Kept, "nativeId">, end: Ended): string {
    if (this.stopping) return NO_AGENT;
    if (end.stopped) return this.stoppedReply(ionId, kept, end);
    const reply = end.late ? TOO_LONG : end.last.trim() || NO_AGENT;
    // A session that failed or said nothing is forgotten: resuming it would likely fail again (its context too long).
    // One that didn't close is too: the agent may still hold it, and two sessions would resume one id.
    const broken = end.stuck || (!end.late && (end.failed || reply === NO_AGENT));
    if (broken) this.forgetSession(ionId);
    else if (end.nativeId) this.keepSession(ionId, { ...kept, nativeId: end.nativeId });
    return reply;
  }

  /** A turn you stopped: its session kept if it closed (resuming it is fine), else forgotten. */
  private stoppedReply(ionId: string, kept: Omit<Kept, "nativeId">, end: Ended): string {
    if (end.stuck) this.forgetSession(ionId);
    else if (end.nativeId) this.keepSession(ionId, { ...kept, nativeId: end.nativeId });
    return STOPPED;
  }

  /** ion chief: an empty folder of its own (made now); a project's ion: its project's folder. */
  private folderOf(ionId: string): string {
    if (ionId !== "chief") {
      const p = loadUserConfig(this.d.configFile).config.projects.find((x) => x.id === ionId);
      if (!p || ionId === DEFAULT_PROJECT) throw new UserError(`Unknown ion: ${ionId}`);
      return p.path;
    }
    const dir = join(this.d.dataDir, "ions", "chief");
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
  private scopeOf(t: TurnRef & { report: boolean }): IonScope {
    const all = loadUserConfig(this.d.configFile).config.projects.filter((p) => p.id !== DEFAULT_PROJECT);
    const projects =
      t.ionId === "chief"
        ? all
            .filter((p) => p.shareWithIon !== false)
            .map((p) => p.id)
            .sort()
        : [t.ionId];
    return { kind: "ion", ionId: t.ionId, projects, turnId: t.turnId, ...(t.report ? { report: true } : {}) };
  }

  /**
   * Starts (or resumes) the ion's session with its keys, sends your message, and reads it to its end or limit; how
   * it ended, and the projects it saw.
   */
  private async session(
    t: TurnRef & { text: string; cwd: string; rules: RuleCtx; report: boolean },
    brain: IonBrain,
    adapter: HarnessAdapter,
  ): Promise<{ end: Ended; projects: string[] }> {
    const scope = this.scopeOf(t);
    const mcpKey = this.d.grants.create(scope);
    const gateKey = adapter.gateCall ? this.d.grants.create(scope, "gate") : null;
    const abort = new AbortController();
    // Your servers that are on, at ion's URL for each with only the turn's key (a report's turn gets none).
    const yours = t.report
      ? { servers: [], envDrop: undefined }
      : await this.yourServers(t.turnId, mcpKey, adapter);
    const opts: StartOpts = {
      cwd: t.cwd,
      model: brain.model,
      effort: brain.effort,
      instructions: ionInstructions(t.ionId),
      // ion's server first, then yours through ion's gateway (ion decides each call there: only what reads).
      mcpServers: [
        {
          name: ION_SERVER,
          transport: "http",
          url: this.d.mcpUrl(),
          headers: { Authorization: `Bearer ${mcpKey}` },
        },
        ...yours.servers,
      ],
      ...(gateKey ? { gate: { url: `${this.d.gateUrl()}/${gateKey}` } } : {}),
      // ion's own agents don't inherit your keys either.
      envDrop: await envDropOf(this.d.configFile),
      signal: abort.signal,
      decide: async (req: ApprovalRequest) => {
        const live = this.live.get(t.turnId);
        return live ? (await ionVerdict(req, t.rules, this.webOf(live), live.served)).decision : "deny";
      },
    };
    const resume = this.resumeOf(t.ionId, brain.harness, scope.projects);
    const end = await this.within(abort, t.turnId, (e, hold) =>
      this.drive({ ...t, adapter, opts, resume }, e, hold),
    );
    return { end, projects: scope.projects };
  }

  /** Your servers for a turn, through ion's gateway with its key; none when ion can't give them. */
  private async yourServers(turnId: string, key: string, adapter: HarnessAdapter) {
    if (!this.d.servers) return { servers: [] };
    const url = this.d.mcpUrl();
    const given = await this.d.servers.open(turnId, { url, key }, adapter.mcpTransports).catch(() => null);
    const live = this.live.get(turnId);
    if (live && given) live.served = given.servers.map((s) => s.name);
    return { servers: given?.servers ?? [] };
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
      timer = setTimeout(() => stop(), this.d.turnMs ?? ION_TURN_MS);
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

  /** Starts (or resumes) the session, sends your message, and reads the session to its end. */
  private async drive(
    t: TurnRef & { text: string; adapter: HarnessAdapter; opts: StartOpts; resume: string | undefined },
    end: Ended,
    hold: (s: Session) => void,
  ): Promise<void> {
    const session = await this.start(t.adapter, t.opts, t.resume);
    hold(session);
    end.nativeId = session.nativeId;
    if (end.late) return;
    await session.send({ text: t.text });
    await this.pump(session, t, end);
  }

  /**
   * The ion's session to resume: only on the agent it was made on, and while it may see the same projects (a project
   * kept from ion chief or removed is forgotten with the session that knew it).
   */
  private resumeOf(ionId: string, harness: string, projects: string[]): string | undefined {
    const s = ionsView.session(this.d.db, ionId);
    const same = s?.projects?.join("\n") === projects.join("\n");
    return s?.harness === harness && same ? s.nativeId : undefined;
  }

  /** A session the agent can't resume (gone, expired) is started anew. */
  private async start(
    adapter: HarnessAdapter,
    opts: StartOpts,
    resume: string | undefined,
  ): Promise<Session> {
    if (!resume) return adapter.start(opts);
    try {
      return await adapter.start({ ...opts, resume });
    } catch (e) {
      if (e instanceof ResumeFailed) return adapter.start(opts);
      throw e;
    }
  }

  /** Keeps the turn's work on the ion's chat (until its limit), its last message, and its native session id. */
  private async pump(session: Session, t: TurnRef, end: Ended): Promise<void> {
    for await (const e of session.events()) {
      if (end.late) return;
      if (KEPT.has(e.type))
        this.d.store.append({ ...e, chatId: `ion:${t.ionId}`, runId: t.turnId, origin: "adapter" });
      this.live.get(t.turnId)?.web.note(e);
      note(e, end);
    }
  }

  /** Forgets the ion's session (when it has one), so its next turn starts a fresh one. */
  private forgetSession(ionId: string): void {
    if (!ionsView.session(this.d.db, ionId)) return;
    this.d.store.append({
      chatId: `ion:${ionId}`,
      runId: null,
      origin: "daemon",
      type: EV.ionSession,
      data: { ionId, harness: null, nativeId: null },
    });
  }

  /** Records the ion's session when it's new (another agent, a session it couldn't resume, other projects). */
  private keepSession(ionId: string, k: Kept): void {
    const s = ionsView.session(this.d.db, ionId);
    const same = s?.projects?.join("\n") === k.projects.join("\n");
    if (s?.harness === k.harness && s.nativeId === k.nativeId && same) return;
    this.d.store.append({
      chatId: `ion:${ionId}`,
      runId: null,
      origin: "daemon",
      type: EV.ionSession,
      data: { ionId, ...k },
    });
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
