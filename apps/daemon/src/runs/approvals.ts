import type { ApprovalRequest, Decision, GateCall } from "@ion/adapter-kit";
import { EV, type IonEvent } from "@ion/schema";
import { type Access, hardRuleFor, onlyPlugin, waryData } from "../access/index.js";
import type { Blocked, Held } from "../decisions/blocked.js";
import { type GateAnswer, GateAllows } from "../gate/index.js";
import type { EventStore } from "../store/index.js";
import { agentKey, gatewayKey, HANDOFF_MS } from "./handoff.js";
import { decideByPolicy } from "./policy.js";

/** What a permission decision needs to know about the run asking. */
export type AskingRun = {
  chatId: string;
  runId: string;
  projectId: string;
  /** What you asked in this run (the judge sees this, never replayed history). */
  request: string;
  access: "auto" | "full";
  mcpKey?: string;
  /** Your servers this run reaches through ion's gateway (ion decides each of their calls there). */
  viaIon?: string[];
  /** This run's skills plugin (in ion's data folder): it may read and run the files there, never write them. */
  pluginDir?: string;
};

/** route: a safer way the agent is told with ion's no. wary: ion's own guess, which asks you (the user, 2026-11-21). */
type Verdict = {
  decision: Decision;
  by: "policy" | "full" | "ion" | "gate" | "you" | "hook";
  reason?: string;
  route?: string;
  wary?: true;
};

/**
 * Your "Before a tool runs" hooks on a call: a refusal (one exited 2) with its reason; a check that didn't finish
 * (one line, for Auto-approval); or null to go on.
 */
export type BeforeTool = (
  r: AskingRun,
  call: Pick<ApprovalRequest, "toolName" | "kind" | "summary" | "input">,
) => Promise<{ reason: string } | { failed: true } | null>;

/**
 * Asks you about a tool call ion stopped, holding it until you answer or 4 minutes pass; `allowed` says whether
 * you said "Always allow" for exactly this action (tool and input) in the run's project.
 */
export type AskBlocked = {
  ask: (r: AskingRun, b: Blocked) => Promise<Held>;
  allowed: (r: AskingRun, key: string) => boolean;
};

/** The exact action: its tool and its whole input. */
const actionKey = (req: ApprovalRequest) => `${req.toolName} ${JSON.stringify(req.input)}`;
const INPUT_SHOWN = 1000;

const HELD: Record<Held, Omit<Verdict, "decision"> & { decision: Decision }> = {
  allow: { decision: "allow", by: "you", reason: "You allowed it" },
  deny: { decision: "deny", by: "you", reason: "You said no" },
  timeout: { decision: "deny", by: "ion", reason: "No answer in 4 minutes" },
};

/** What a gate allow and a later prompt are matched on: the kind of call and its command or file. */
const callKey = (c: { kind: string; input: Record<string, unknown> }) => {
  const id = [c.input.command, c.input.file_path].find((v) => typeof v === "string") as string | undefined;
  return id === undefined ? { kind: c.kind } : { kind: c.kind, id };
};

/** Allows decided for exactly this call (never the gate's loose allows, nor the policy's), which may hand off. */
const HANDED = new Set<Verdict["by"]>(["ion", "you", "full"]);

/** Added to every Auto deny an agent reads: the way through is asking you. */
const ASK_HINT = " — if it's needed, ask the user with ion's ask tool";

/**
 * Every permission request a harness makes. Inside the worktree (and ion's own MCP tools): allowed by policy.
 * Anything else goes by the run's access: Full access allows it; Auto lets ion decide (rules, then the judge).
 * The run never pauses for you. Each decision is stored after the request it answers.
 */
export class Approvals {
  private readonly requested = new Map<string, () => void>();
  private readonly allows = new GateAllows();
  /** Calls on your servers the agent's side just allowed: ion's gateway doesn't ask the judge (or you) again. */
  private readonly handoffs = new GateAllows(Date.now, HANDOFF_MS);
  private gateCount = 0;

  constructor(
    private readonly store: EventStore,
    private readonly access: Access | undefined,
    /** False once the run has ended (interrupt, shutdown): its log is closed. */
    private readonly isOpen: (runId: string) => boolean,
    private readonly opts: {
      /** Your home folder and ion's own folders: what no run may touch, in any access mode. */
      own: { home: string; ionDirs: string[] };
      /** When the judge says no (or can't decide), ion asks you instead of just refusing. */
      askBlocked?: AskBlocked;
      /** Your "Before a tool runs" hooks: after ion's own files, before everything else. */
      beforeTool?: BeforeTool;
    },
  ) {}

  /** A permission prompt from the harness. One the gate already allowed is answered from that allow. */
  async decide(r: AskingRun, req: ApprovalRequest, roots: string[]): Promise<Decision> {
    await this.waitForRequest(req.requestId);
    if (!this.isOpen(r.runId)) return "deny";
    const v: Verdict = this.allows.take(r.runId, callKey(req))
      ? { decision: "allow", by: "gate" }
      : await this.verdict(r, req, roots);
    if (!this.isOpen(r.runId)) return v.decision;
    this.record(r, { requestId: req.requestId, ...v });
    this.handOff(r, req, v);
    return v.decision;
  }

  /**
   * A tool call reported by the harness's own hook, before it runs. Only Auto's decisions are stored (policy
   * and Full access stay quiet); an allow is kept for the permission prompt that may follow.
   */
  async gate(r: AskingRun, call: GateCall, roots: string[]): Promise<GateAnswer> {
    if (!this.isOpen(r.runId)) return { decision: "deny", reason: "This run has ended" };
    const req: ApprovalRequest = { requestId: `g${++this.gateCount}`, toolId: "", ...call };
    const v = await this.verdict(r, req, roots);
    if (!this.isOpen(r.runId)) return { decision: "deny", reason: "This run has ended" };
    this.handOff(r, req, v);
    if (v.decision === "allow") this.allows.add(r.runId, callKey(call));
    return this.answer(r, req, v);
  }

  /**
   * A tools/call ion's gateway is about to send to one of your servers, with its real name and input: ion's own
   * files and keys first; then, if the agent's side just allowed exactly this call, that allow; else the run's
   * access, as for any call. Recorded like the gate's; never kept for a later prompt.
   */
  async gateway(r: AskingRun, call: GateCall, roots: string[]): Promise<GateAnswer> {
    if (!this.isOpen(r.runId)) return { decision: "deny", reason: "This run has ended" };
    const req: ApprovalRequest = { requestId: `g${++this.gateCount}`, toolId: "", ...call };
    const own = this.ownFiles(req, roots, r.pluginDir);
    let v: Verdict;
    if (own && !own.wary) v = own;
    else if (!own && this.handoffs.take(r.runId, gatewayKey(call))) v = { decision: "allow", by: "gate" };
    else v = await this.verdict(r, req, roots); // a guess is judged or asked there
    if (!this.isOpen(r.runId)) return { decision: "deny", reason: "This run has ended" };
    return this.answer(r, req, v);
  }

  /** Records ion's or your decision on a reported call, and answers it. */
  private answer(r: AskingRun, req: ApprovalRequest, v: Verdict): GateAnswer {
    if (v.by === "ion" || v.by === "you" || v.by === "hook")
      this.record(r, { requestId: req.requestId, ...v, summary: req.summary });
    if (v.decision === "allow") return { decision: "allow" };
    // A hook's no is yours, said in its own words.
    if (v.by === "hook") return { decision: "deny", reason: v.reason ?? "Not allowed" };
    // ion's own no says the safer route (the user, 2026-11-21); others, that asking you is the way through.
    const after = v.route ? ` — ${v.route}` : ASK_HINT;
    return { decision: "deny", reason: `${v.reason ?? "Not allowed"}${after}` };
  }

  /** The agent's side allowed a call on one of your servers ion's gateway serves: the gateway takes that allow. */
  private handOff(r: AskingRun, req: ApprovalRequest, v: Verdict): void {
    const key = r.viaIon?.length ? agentKey(req, r.viaIon) : null;
    if (!key) return;
    // A no on the agent's side: nothing it allowed of this call before still stands.
    if (v.decision !== "allow") while (this.handoffs.take(r.runId, key));
    else if (HANDED.has(v.by) && !this.handoffs.has(r.runId, key)) this.handoffs.add(r.runId, key);
  }

  /** The run ended: its gate allows go. */
  forget(runId: string): void {
    this.allows.drop(runId);
    this.handoffs.drop(runId);
  }

  private record(r: AskingRun, v: Verdict & { requestId: string; summary?: string }): void {
    const data = {
      requestId: v.requestId,
      decision: v.decision,
      by: v.by,
      ...(v.reason ? { reason: v.reason } : {}),
      ...(v.summary ? { summary: v.summary } : {}),
    };
    this.store.append({
      chatId: r.chatId,
      runId: r.runId,
      origin: "daemon",
      type: EV.approvalResolved,
      data,
    });
  }

  /** Call with every stored adapter event: an approval.requested lets its decision be stored after it. */
  noteStored(e: IonEvent): void {
    if (e.type !== EV.approvalRequested) return;
    const id = (e.data as { requestId: string }).requestId;
    const waiter = this.requested.get(id);
    if (waiter) {
      this.requested.delete(id);
      waiter();
    } else this.requested.set(`seen:${id}`, () => {});
  }

  /**
   * ion's own files and keys: refused first, in every access mode; a check that fails refuses too. A guess (wary)
   * asks you instead, in every mode (the user, 2026-11-21).
   */
  private ownFiles(req: ApprovalRequest, roots: string[], plugin?: string): Verdict | null {
    try {
      const v = hardRuleFor(req, { roots, ...this.opts.own, ...(plugin ? { plugin } : {}) });
      if (!v) return null;
      return {
        decision: "deny",
        by: "ion",
        reason: v.reason,
        route: v.route,
        ...(v.wary ? { wary: v.wary } : {}),
      };
    } catch {
      return { decision: "deny", by: "ion", reason: "ion couldn't check its own files" };
    }
  }

  /** Reads only the run's own skills plugin (a skill's files): allowed like the worktree, without the judge. */
  private readsPlugin(r: AskingRun, req: ApprovalRequest, roots: string[]): boolean {
    if (!r.pluginDir) return false;
    try {
      return onlyPlugin(req, { roots, ...this.opts.own, plugin: r.pluginDir });
    } catch {
      return false;
    }
  }

  /** Your "Before a tool runs" hooks; one that can't be run lets the call go on (it's reported there). */
  /** Your hooks' no; or that one of them didn't finish (hooks that couldn't be asked at all count too). */
  private async hooksOn(
    r: AskingRun,
    req: ApprovalRequest,
  ): Promise<Verdict | { checksFailed: true } | null> {
    if (!this.opts.beforeTool) return null;
    const said = await this.opts.beforeTool(r, req).catch(() => ({ failed: true as const }));
    if (!said) return null;
    return "reason" in said ? { decision: "deny", by: "hook", reason: said.reason } : { checksFailed: true };
  }

  private async verdict(r: AskingRun, req: ApprovalRequest, roots: string[]): Promise<Verdict> {
    const own = this.ownFiles(req, roots, r.pluginDir);
    if (own && !own.wary) return own;
    const hooks = await this.hooksOn(r, req);
    if (hooks && "decision" in hooks) return hooks;
    // A guess: in Full (no judge) it asks you; in Auto the judge decides, shown what will run.
    if (own && r.access === "full") return this.wary(r, req, own);
    if (own) return this.auto(r, req, roots, { checksFailed: !!hooks, wary: own });
    if (
      decideByPolicy(req, { roots, ionMcp: Boolean(r.mcpKey) }) === "allow" ||
      this.readsPlugin(r, req, roots)
    )
      return { decision: "allow", by: "policy" };
    if (r.access === "full") return { decision: "allow", by: "full" };
    return this.auto(r, req, roots, { checksFailed: !!hooks });
  }

  /** Auto: ion's rules, then the judge (told when one of your checks before tools run didn't finish). */
  private async auto(
    r: AskingRun,
    req: ApprovalRequest,
    roots: string[],
    { checksFailed, wary }: { checksFailed: boolean; wary?: Verdict },
  ): Promise<Verdict> {
    if (!this.access)
      return { decision: "deny", by: "ion", reason: "ion couldn't decide: Auto isn't set up" };
    const at = {
      ...{ chatId: r.chatId, projectId: r.projectId, text: r.request, roots },
      ...(r.pluginDir ? { plugin: r.pluginDir } : {}),
    };
    const data =
      wary &&
      waryData(
        req,
        { roots, ...this.opts.own, ...(r.pluginDir ? { plugin: r.pluginDir } : {}) },
        wary.reason ?? "",
      );
    const v = await this.access.decide(
      { ...at, ...(checksFailed ? { checksFailed } : {}), ...(data ? { wary: data } : {}) },
      req,
    );
    // The judge's no (or unsure) on ion's guess: you're asked, as ion is wary.
    if (wary && v.decision === "deny" && v.source === "judge") return this.wary(r, req, wary);
    // A rule's no (your secrets, ion's files) stands. The judge's no is a question for you.
    if (v.decision === "deny" && v.source === "judge" && this.opts.askBlocked)
      return this.askYou(this.opts.askBlocked, r, req, { reason: v.reason });
    return { decision: v.decision, by: "ion", reason: v.reason };
  }

  /** ion's guess, asked of you (in Full, or after the judge's no); with no one to ask, refused with its route. */
  private async wary(r: AskingRun, req: ApprovalRequest, v: Verdict): Promise<Verdict> {
    if (!this.opts.askBlocked) return v;
    return this.askYou(this.opts.askBlocked, r, req, { reason: v.reason ?? "", wary: true });
  }

  /** The judge said no (or ion is wary): unless you always allow exactly this action here, ask you and hold the call. */
  private async askYou(
    a: AskBlocked,
    r: AskingRun,
    req: ApprovalRequest,
    { reason, wary }: { reason: string; wary?: true },
  ): Promise<Verdict> {
    const key = actionKey(req);
    if (a.allowed(r, key)) return { decision: "allow", by: "you", reason: "You always allow this" };
    const full = JSON.stringify(req.input, null, 2);
    const cut = full.length > INPUT_SHOWN;
    const input = cut ? `${full.slice(0, INPUT_SHOWN)}\n… (cut)` : full;
    const b = {
      ...{ requestId: req.requestId, summary: req.summary, reason, input, key },
      ...(cut ? { cut } : {}),
      ...(wary ? { wary } : {}),
    };
    return HELD[await a.ask(r, b)];
  }

  /** Resolves once the adapter's approval.requested for this id is stored, so the log stays in order. */
  private waitForRequest(requestId: string): Promise<void> {
    if (this.requested.has(`seen:${requestId}`)) return Promise.resolve();
    return new Promise((resolve) => this.requested.set(requestId, resolve));
  }
}
