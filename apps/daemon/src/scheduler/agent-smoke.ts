import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AdapterEvent,
  type ApprovalRequest,
  type HarnessAdapter,
  ION_SERVER,
  type Session,
  type StartOpts,
} from "@ion/adapter-kit";
import { type AgentCheckItem, EV, type HarnessInfo } from "@ion/schema";
import type { RuleCtx } from "../access/rules.js";
import type { GateAnswer } from "../gate/server.js";
import { decideForIon } from "../ions/gate.js";
import { closing } from "../ions/turn-end.js";
import { ionRules } from "../ions/turn.js";
import { CHECK_ION } from "../mcp/check-tool.js";
import type { Grants, IonScope } from "../mcp/index.js";

export { CHECK_ION };

/** How long an agent has to answer its check. */
const LIMIT_MS = 3 * 60_000;
/** ion's check tool as each agent names it: `mcp__ion__check` (Claude Code), `ion__check` (Grok), `ion_check`. */
const CHECK_TOOL = /^(mcp__)?ion_{1,2}check$/;

const PROMPT = [
  "ion is checking that you work. Do exactly this, nothing else:",
  "1. Call the tool `check` on the MCP server named `ion`. It gives you a word.",
  "2. Read the file word.txt in your current folder. It holds another word.",
  "Reply with only the two words, separated by a space.",
].join("\n");

type SmokeDeps = {
  /**
   * Hears each event of a check's session with its agent's id: what goes in the agent's usage, and a limit it hits
   * (its mark: Automatic and the next night skip it until it resets; recordTo, as ion's turns and the judge do).
   */
  record?: (harness: string, e: AdapterEvent, startedAt: string) => void;
  dataDir: string;
  configFile: string;
  grants: Grants;
  mcpUrl: () => string;
  gateUrl: () => string;
  adapter: (id: string) => HarnessAdapter | undefined;
  /** The agent read again now (its sign-in). */
  info: (id: string) => Promise<HarnessInfo | undefined>;
  /** What one of ion's own agent processes starts with: your keys kept from it, its sandbox. */
  own: (cwd: string, harness: string) => Promise<Pick<StartOpts, "envDrop" | "sandbox">>;
  limitMs?: number;
  home?: string;
};

/** How its answer ended: its last message, its first error, out of time, and its limit's words when it hit one. */
type End = { reply: string; error: string; late: boolean; limit: string | null };

/** A check while it runs: its agent (to read its gate's calls), its read rules, and how many calls reached ion. */
type Live = { adapter: HarnessAdapter; rules: RuleCtx; seen: number };

/** The first line of an error, short. */
const short = (e: unknown) =>
  String((e as Error)?.message ?? e)
    .split("\n")[0]!
    .slice(0, 120);

/** A promise that settles when the signal aborts. */
const aborted = (signal: AbortSignal) =>
  new Promise<void>((r) => {
    if (signal.aborted) r();
    else signal.addEventListener("abort", () => r(), { once: true });
  });

/**
 * One agent's nightly check (Plan 21 Task 5), for real but small: still signed in; it starts (in a fresh folder of
 * the temp folder, sandboxed as ion's own agents are, your keys kept from it); it answers a one-line task; the word
 * only ion's MCP tool gives comes back (ion's tools work); its calls reach ion's gate. Its session is closed, its keys
 * revoked and its folder removed however it ends (past its limit, ion stopping, the agent failing).
 */
export class AgentSmoke {
  private readonly live = new Map<string, Live>();

  constructor(private readonly d: SmokeDeps) {}

  /** A check's call at ion's gate (its gate key's check); null when it's no check going, or ion can't read it. */
  gate(scope: IonScope, payload: unknown): GateAnswer | null {
    const t = this.live.get(scope.turnId);
    const call = t?.adapter.gateCall?.(payload);
    if (!t || !call) return null;
    return this.verdict(t, { requestId: "gate", toolId: "gate", ...call });
  }

  /**
   * ion's check tool, and reads ions may make (its folder); nothing else. The tool by its name, whatever kind the
   * agent gives it (live check, 2026-11-28: opencode's hook names it `ion_check`, kind "other").
   */
  private verdict(t: Live, req: ApprovalRequest): GateAnswer {
    t.seen++;
    // Only ion's own server's, when the agent names the server (Task 5 review, 2026-11-28).
    const ion = req.mcpServer === undefined || req.mcpServer === null || req.mcpServer === ION_SERVER;
    if (CHECK_TOOL.test(req.toolName) && ion) return { decision: "allow" };
    if (req.kind === "mcp") return { decision: "deny" };
    return { decision: decideForIon(req, t.rules) };
  }

  async run(agent: string, model: string | null, signal: AbortSignal): Promise<AgentCheckItem[]> {
    const info = await this.d.info(agent).catch(() => undefined);
    const signed = !!info?.signedIn;
    const items: AgentCheckItem[] = [
      {
        name: "Signed in",
        ok: signed,
        ...(signed ? {} : { note: info?.signInUnknown ? "Couldn't tell" : "Signed out" }),
      },
    ];
    const adapter = this.d.adapter(agent);
    if (!signed) return items;
    if (!adapter) return [...items, { name: "Starts", ok: false, note: "Unknown agent" }];
    return [...items, ...(await this.session(adapter, model, signal))];
  }

  /** Starts the agent with the check's keys, gives it the task, and reads its answer; all of it undone after. */
  private async session(
    adapter: HarnessAdapter,
    model: string | null,
    signal: AbortSignal,
  ): Promise<AgentCheckItem[]> {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ion-check-")));
    const word = randomBytes(4).toString("hex");
    writeFileSync(join(dir, "word.txt"), `${randomBytes(4).toString("hex")}\n`);
    const turnId = `check_${randomUUID()}`;
    const live: Live = { adapter, rules: ionRules(this.d, dir), seen: 0 };
    this.live.set(turnId, live);
    const abort = new AbortController();
    const stop = () => abort.abort();
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const timer = setTimeout(stop, this.d.limitMs ?? LIMIT_MS);
    let session: Session | undefined;
    try {
      const scope: IonScope = {
        kind: "ion",
        ionId: CHECK_ION,
        projects: [],
        turnId,
        report: true,
        check: { word },
      };
      const opts = await this.optsOf(adapter, { dir, model, scope, abort, live });
      session = await this.started(adapter.start(opts), abort.signal);
      if (!session)
        return [{ name: "Starts", ok: false, note: abort.signal.aborted ? "Too slow" : "Didn't start" }];
      const end = await this.answer(session, abort.signal, adapter.id);
      return [{ name: "Starts", ok: true }, ...this.found(end, word, live)];
    } catch (e) {
      return [{ name: "Starts", ok: false, note: short(e) }];
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      abort.abort();
      if (session) await closing(session);
      this.live.delete(turnId);
      this.d.grants.revoke(turnId);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private async optsOf(
    adapter: HarnessAdapter,
    o: { dir: string; model: string | null; scope: IonScope; abort: AbortController; live: Live },
  ): Promise<StartOpts> {
    const key = this.d.grants.create(o.scope);
    const gateKey = adapter.gateCall ? this.d.grants.create(o.scope, "gate") : null;
    return {
      cwd: o.dir,
      model: o.model,
      effort: null,
      instructions: "ion is checking that you work. Do what the message says, nothing more.",
      mcpServers: [
        {
          name: ION_SERVER,
          transport: "http",
          url: this.d.mcpUrl(),
          headers: { Authorization: `Bearer ${key}` },
        },
      ],
      ...(gateKey ? { gate: { url: `${this.d.gateUrl()}/${gateKey}` } } : {}),
      ...(await this.d.own(o.dir, adapter.id)),
      signal: o.abort.signal,
      decide: async (req) => this.verdict(o.live, req).decision,
    };
  }

  /** The session once it starts, or undefined when the check ends first (one that starts later is closed then). */
  private async started(start: Promise<Session>, signal: AbortSignal): Promise<Session | undefined> {
    const s = await Promise.race([start, aborted(signal).then(() => undefined)]);
    if (!s) void start.then((late) => closing(late)).catch(() => {});
    return s;
  }

  /** Sends the task and reads to the end: its last message and its error, or that it ran out of time. */
  private async answer(session: Session, signal: AbortSignal, harness: string): Promise<End> {
    const end: End = { reply: "", error: "", late: false, limit: null };
    const startedAt = new Date().toISOString();
    const read = (async () => {
      await session.send({ text: PROMPT });
      for await (const e of session.events()) {
        this.d.record?.(harness, e, startedAt);
        if (e.type === EV.messageCompleted) end.reply = String((e.data as { text?: unknown }).text ?? "");
        if (e.type === EV.error) this.failed(end, e.data as { message?: unknown; limit?: unknown });
      }
    })();
    read.catch((e: unknown) => {
      end.error ||= short(e);
    });
    await Promise.race([read.catch(() => {}), aborted(signal)]);
    end.late = signal.aborted && !end.reply;
    return end;
  }

  /** Its error: the first one's words, and whether it's the agent's limit (its use is used up). */
  private failed(end: End, d: { message?: unknown; limit?: unknown }): void {
    const message = String(d.message ?? "");
    end.error ||= short(message);
    if (d.limit && !end.limit)
      end.limit = /free/i.test(message) ? "Its free use is used up" : "It hit its limit";
  }

  /**
   * What its answer shows: it answered, ion's tool's word came back, a call reached ion's gate. Used up isn't broken
   * (Task 5 review, 2026-11-28): it says so, and what couldn't be tried then isn't counted.
   */
  private found(end: End, word: string, live: Live): AgentCheckItem[] {
    if (end.limit && !end.reply.trim())
      return [{ name: "Answers", ok: true, limited: true, note: end.limit }];
    const said = end.reply.trim();
    const why = end.late ? "No answer in time" : end.error || "Said nothing";
    return [
      { name: "Answers", ok: !!said, ...(said ? {} : { note: why }) },
      {
        name: "ion's tools",
        ok: said.includes(word),
        ...(said.includes(word) ? {} : { note: "ion's word didn't come back" }),
      },
      { name: "Gate", ok: live.seen > 0, ...(live.seen ? {} : { note: "No call reached ion's gate" }) },
    ];
  }
}
