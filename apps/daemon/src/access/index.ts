import { createHash } from "node:crypto";
import type { ApprovalRequest } from "@ion/adapter-kit";
import type { WaryData } from "./hard.js";
import type { Judge } from "./judge.js";
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
};
/** source: a rule (your secrets, ion's files: never asks you) or the judge (its "no" asks you). */
type AccessVerdict = Verdict & { source: "rule" | "judge" };
export type Access = { decide(at: At, req: ApprovalRequest): Promise<AccessVerdict> };

/** Auto: rules first, then the judge, at most once per action in a chat. */
export function createAccess(o: {
  judge: Judge;
  home: string;
  ionDirs: string[];
  /** Your decisions that apply in a chat, for the judge (Plan 06). */
  decisionsFor?: (projectId: string, chatId: string) => string[];
}): Access {
  const cache = new Map<string, AccessVerdict>();
  return {
    async decide(at, req) {
      const ctx = { roots: at.roots, home: o.home, ionDirs: o.ionDirs };
      // Every rule holds for a guess too (security review, 2026-11-21); only a rule's allow doesn't skip the judge.
      const rule = ruleFor(req, at.plugin ? { ...ctx, plugin: at.plugin } : ctx);
      if (rule && !(at.wary && rule.decision === "allow")) return { ...rule, source: "rule" };
      // The same action for the same request in a chat: one judge call.
      const hash = createHash("sha256")
        .update(
          JSON.stringify([
            at.text,
            req.toolName,
            req.input,
            o.decisionsFor?.(at.projectId, at.chatId),
            !!at.checksFailed,
            // Keyed on the scripts' contents: a changed script is judged again.
            at.wary ?? null,
          ]),
        )
        .digest("hex");
      const key = `${at.chatId}:${hash}`;
      const known = cache.get(key);
      if (known) return known;
      const decisions = o.decisionsFor?.(at.projectId, at.chatId) ?? [];
      const v = await o.judge({
        projectId: at.projectId,
        text: at.text,
        req,
        ...(decisions.length ? { decisions } : {}),
        ...(at.checksFailed ? { checksFailed: true as const } : {}),
        ...(at.wary ? { wary: at.wary } : {}),
      });
      const verdict: AccessVerdict = {
        decision: v.allow ? "allow" : "deny",
        reason: v.reason,
        source: "judge",
      };
      // A judge that couldn't decide (slow, signed out) is asked again next time.
      if (v.decided !== false) cache.set(key, verdict);
      return verdict;
    },
  };
}
