import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AdapterEvent,
  type ApprovalRequest,
  type HarnessAdapter,
  projectRoots,
  ResumeFailed,
  type Session,
  type StartOpts,
} from "@ion/adapter-kit";
import { DEFAULT_PROJECT, loadUserConfig } from "@ion/config";
import { EV, type HarnessInfo } from "@ion/schema";
import type { RuleCtx } from "../access/rules.js";
import { getHarness } from "../adapters/registry.js";
import { UserError } from "../api/errors.js";
import type { GateAnswer } from "../gate/index.js";
import type { Grants, IonScope } from "../mcp/index.js";
import type { Db, EventStore } from "../store/index.js";
import { ionsView } from "../views/ions.js";
import { type IonBrain, ionBrain } from "./brain.js";
import { decideForIon } from "./gate.js";
import { ionInstructions } from "./instructions.js";

/** A turn's hard limit: past it the agent is stopped and the ion says it couldn't finish. */
const ION_TURN_MS = 300_000;
export const NO_AGENT = "I couldn't reach my agent; try again.";
export const TOO_LONG = "I couldn't finish that in time.";
const READ_ONLY = "An ion only reads; a thread does the work.";

/** What of a turn's session is kept on the ion's chat, so the app can draw its work. */
const KEPT: ReadonlySet<string> = new Set([EV.toolStarted, EV.toolFinished, EV.thinkingDelta]);

type Thread = { chatId: string; projectId: string };
type TurnRef = { ionId: string; turnId: string };

/**
 * Starts a thread for an ion's turn: its chat, or why it couldn't. `turn.request` is your own message (what the
 * judge reads as your request), never the brief the ion's agent wrote.
 */
type StartIonThread = (
  projectId: string,
  brief: string,
  turn: { ionId: string; request: string },
) => Promise<{ chatId: string } | { why: string }>;

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
  startThread: StartIonThread;
  /** The turn's hard limit (tests make it short). */
  turnMs?: number;
  home?: string;
};

/** A turn while it runs: what its tools and its gate need. */
type Live = { ionId: string; request: string; adapter: HarnessAdapter; rules: RuleCtx; threads: Thread[] };

/** How a turn's session ended: its last message, its native id, and whether it ran past its limit. */
type Ended = { last: string; nativeId: string | null; late: boolean };

/** Notes the session's last message, and its native id once the agent says it (some only say it when it starts). */
function note(e: AdapterEvent, end: Ended): void {
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

  constructor(private readonly d: IonTurnsDeps) {}

  /** Your message to an ion: waits for its turn before (one session per ion at a time), then thinks. */
  turn(ionId: string, text: string): Promise<{ reply: string; threads: Thread[] }> {
    const next = (this.chains.get(ionId) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.run(ionId, text));
    this.chains.set(ionId, next);
    return next;
  }

  /** start_thread for a live turn (ion's MCP server): the thread joins the turn's reply. */
  readonly startThread = async (projectId: string, brief: string, turnId: string) => {
    const t = this.live.get(turnId);
    if (!t) return { why: "That turn is over" };
    const r = await this.d.startThread(projectId, brief, { ionId: t.ionId, request: t.request });
    if ("chatId" in r) t.threads.push({ chatId: r.chatId, projectId });
    return r;
  };

  /** A tool call a turn's hook reported (its gate key's turn); null when the harness's payload isn't one. */
  async gate(scope: IonScope, payload: unknown): Promise<GateAnswer | null> {
    const t = this.live.get(scope.turnId);
    const call = t?.adapter.gateCall?.(payload);
    if (!t || !call) return null;
    const req = { requestId: "gate", toolId: "gate", ...call };
    return decideForIon(req, t.rules) === "allow"
      ? { decision: "allow" }
      : { decision: "deny", reason: READ_ONLY };
  }

  private async run(ionId: string, text: string): Promise<{ reply: string; threads: Thread[] }> {
    const cwd = this.folderOf(ionId);
    const brain = await ionBrain(this.d, ionId).catch(() => null);
    const h = brain && getHarness(brain.harness);
    if (!brain || !h) return { reply: NO_AGENT, threads: [] };
    const turnId = `turn_${randomUUID()}`;
    const rules = this.rulesFor(cwd);
    const live: Live = { ionId, request: text, adapter: h.adapter, rules, threads: [] };
    this.live.set(turnId, live);
    try {
      const end = await this.session({ ionId, turnId, text, cwd, rules }, brain, h.adapter);
      if (end.nativeId) this.keepSession(ionId, brain.harness, end.nativeId);
      const reply = end.late ? TOO_LONG : end.last.trim() || NO_AGENT;
      return { reply, threads: live.threads };
    } catch (e) {
      console.error(`ion's agent (${brain.harness}): ${e instanceof Error ? e.name : "an error"}`);
      return { reply: NO_AGENT, threads: live.threads };
    } finally {
      this.live.delete(turnId);
      this.d.grants.revoke(turnId);
    }
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

  /** What an ion may read: its folder (a project's repo), never your secrets or ion's own files. */
  private rulesFor(cwd: string): RuleCtx {
    return {
      roots: projectRoots(cwd),
      home: this.d.home ?? homedir(),
      ionDirs: [
        this.d.dataDir,
        dirname(this.d.configFile),
        ...(process.env.GROK_HOME ? [process.env.GROK_HOME] : []),
      ],
    };
  }

  /** The projects an ion's tools may see: ion chief those shared with it, a project's ion its own. */
  private scopeOf(ionId: string, turnId: string): IonScope {
    const all = loadUserConfig(this.d.configFile).config.projects.filter((p) => p.id !== DEFAULT_PROJECT);
    const projects =
      ionId === "chief" ? all.filter((p) => p.shareWithIon !== false).map((p) => p.id) : [ionId];
    return { kind: "ion", ionId, projects, turnId };
  }

  /** Starts (or resumes) the ion's session with its keys, sends your message, and reads it to its end or limit. */
  private session(
    t: TurnRef & { text: string; cwd: string; rules: RuleCtx },
    brain: IonBrain,
    adapter: HarnessAdapter,
  ) {
    const scope = this.scopeOf(t.ionId, t.turnId);
    const mcpKey = this.d.grants.create(scope);
    const gateKey = adapter.gateCall ? this.d.grants.create(scope, "gate") : null;
    const abort = new AbortController();
    const opts: StartOpts = {
      cwd: t.cwd,
      model: brain.model,
      effort: brain.effort,
      instructions: ionInstructions(t.ionId),
      mcp: { name: "ion", url: this.d.mcpUrl(), headers: { Authorization: `Bearer ${mcpKey}` } },
      ...(gateKey ? { gate: { url: `${this.d.gateUrl()}/${gateKey}` } } : {}),
      signal: abort.signal,
      decide: async (req: ApprovalRequest) => decideForIon(req, t.rules),
    };
    const resume = this.resumeOf(t.ionId, brain.harness);
    return this.within(abort, (end, hold) => this.drive({ ...t, adapter, opts, resume }, end, hold));
  }

  /**
   * Runs a turn's work under its hard limit: past it the agent is told to stop (its signal, its session interrupted)
   * and ion doesn't wait for it, even if it doesn't stop.
   */
  private async within(
    abort: AbortController,
    work: (end: Ended, hold: (s: Session) => void) => Promise<void>,
  ): Promise<Ended> {
    const end: Ended = { last: "", nativeId: null, late: false };
    let session: Session | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((r) => {
      timer = setTimeout(() => {
        end.late = true;
        abort.abort();
        void session?.interrupt().catch(() => {});
        r();
      }, this.d.turnMs ?? ION_TURN_MS);
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
      await session?.close().catch(() => {});
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

  /** The ion's session to resume: only on the agent it was made on. */
  private resumeOf(ionId: string, harness: string): string | undefined {
    const s = ionsView.session(this.d.db, ionId);
    return s?.harness === harness ? s.nativeId : undefined;
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
      note(e, end);
    }
  }

  /** Records the ion's session when it's new (another agent, or a session it couldn't resume). */
  private keepSession(ionId: string, harness: string, nativeId: string): void {
    const s = ionsView.session(this.d.db, ionId);
    if (s?.harness === harness && s.nativeId === nativeId) return;
    this.d.store.append({
      chatId: `ion:${ionId}`,
      runId: null,
      origin: "daemon",
      type: EV.ionSession,
      data: { ionId, harness, nativeId },
    });
  }
}
