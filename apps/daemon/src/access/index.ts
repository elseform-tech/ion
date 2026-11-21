import { createHash } from "node:crypto";
import type { ApprovalRequest } from "@ion/adapter-kit";
import type { WaryData } from "./hard.js";
import type { Judge, JudgeInput } from "./judge.js";
import { ruleFor, type Verdict } from "./rules.js";

export { createJudge, type Judge, judgePrompt, parseVerdict } from "./judge.js";
export { hardRuleFor, ionDirsOf, waryData } from "./hard.js";
export { onlyPlugin } from "./plugin.js";
export { ruleFor } from "./rules.js";
export { harnessRunner } from "./runner.js";

/** checksFailed: one of your checks before tools run didn't finish or failed (the judge is told, in ion's words). */
/** plugin: the run's own skills plugin folder, which it may read and run (never ion's own files to it). */
type At = {
  chatId: string;
  projectId: string;
  text: string;
  roots: string[];
  checksFailed?: boolean;
  plugin?: string;
  /** ion's guess about this call (the user, 2026-11-21): the judge decides, shown what will run. */
  wary?: WaryData;
  /** The skills you picked with "/" for this message (the judge is told, in ion's words). */
  picked?: string[];
  /** The run's agent (harness id): reads of other agents' settings aren't free. */
  agent?: string;
  /** Lines from the agent's own settings for the judge (Codex trusts this project). */
  notes?: string[];
  /** The agent's own allow rule covers this call (your decision): allowed above the floor, unless ion is wary. */
  allowedBy?: string;
};
/** source: a rule (your secrets, ion's files: never asks you) or the judge (its "no" asks you). */
/** unsure: the judge's no is that it's missing information (the user, 2026-11-21); asked like a no, never kept. */
/** undecided: the judge gave no verdict (failed, slow, garbled): asked as "ion couldn't decide", nothing recorded. */
export type AccessVerdict = Verdict & { source: "rule" | "judge"; unsure?: true; undecided?: true };
export type Access = { decide(at: At, req: ApprovalRequest): Promise<AccessVerdict> };

/** What the judge is shown: your request, the action, your decisions, and ion's notes (checks, guess, picks). */
function judgeInput(at: At, req: ApprovalRequest, yours: string[]): JudgeInput {
  const decisions = [...yours, ...(at.notes ?? [])];
  return {
    ...{ projectId: at.projectId, text: at.text, req },
    ...(decisions.length ? { decisions } : {}),
    ...(at.checksFailed ? { checksFailed: true as const } : {}),
    ...(at.wary ? { wary: at.wary } : {}),
    ...(at.picked?.length ? { picked: at.picked } : {}),
  };
}

/** The same action for the same request (and decisions, checks and scripts) in a chat. */
function cacheKey(at: At, req: ApprovalRequest, decisions?: string[]): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        at.text,
        req.toolName,
        req.input,
        decisions,
        !!at.checksFailed,
        // Keyed on the scripts' contents: a changed script is judged again.
        at.wary ?? null,
        at.picked ?? null,
        at.notes ?? null,
      ]),
    )
    .digest("hex");
  return `${at.chatId}:${hash}`;
}

/** The judge's answer as Auto's verdict: allow, or deny (marked when it was unsure). */
const fromJudge = (v: Awaited<ReturnType<Judge>>): AccessVerdict => ({
  decision: v.verdict === "allow" ? "allow" : "deny",
  reason: v.reason,
  source: "judge",
  ...(v.verdict === "unsure" ? { unsure: true as const } : {}),
  ...(v.decided === false ? { undecided: true as const } : {}),
});

/** Auto: rules first, then the judge, at most once per action in a chat. */
export function createAccess(o: {
  judge: Judge;
  home: string;
  ionDirs: string[];
  /** Your decisions that apply in a chat, for the judge (Plan 06). */
  decisionsFor?: (projectId: string, chatId: string) => string[];
  /** Told each time the judge is unsure (the user, 2026-11-21: often unsure on one kind is noted). */
  onUnsure?: (req: ApprovalRequest) => void;
}): Access {
  const cache = new Map<string, AccessVerdict>();
  return {
    async decide(at, req) {
      // Auto reads anywhere but your secrets, ion's files and other agents' settings (the user, 2026-11-21).
      const ctx = {
        ...{ roots: at.roots, home: o.home, ionDirs: o.ionDirs, freeReads: true as const },
        ...(at.agent ? { agent: at.agent } : {}),
      };
      // Every rule holds for a guess too (security review, 2026-11-21); only a rule's allow doesn't skip the judge.
      const rule = ruleFor(req, at.plugin ? { ...ctx, plugin: at.plugin } : ctx);
      if (rule && !(at.wary && rule.decision === "allow")) return { ...rule, source: "rule" };
      // Your agent's own allow (the user, 2026-11-21): the floor above held; a guess of ion's still goes to the judge.
      if (at.allowedBy && !at.wary) return { decision: "allow", reason: at.allowedBy, source: "rule" };
      // The same action for the same request in a chat: one judge call.
      const key = cacheKey(at, req, o.decisionsFor?.(at.projectId, at.chatId));
      const known = cache.get(key);
      if (known) return known;
      const v = await o.judge(judgeInput(at, req, o.decisionsFor?.(at.projectId, at.chatId) ?? []));
      const verdict = fromJudge(v);
      // A judge that couldn't decide (slow, signed out) or wasn't sure is asked again next time.
      if (v.verdict === "unsure") o.onUnsure?.(req);
      else if (v.decided !== false) cache.set(key, verdict);
      return verdict;
    },
  };
}
