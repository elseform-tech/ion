import { createHash } from "node:crypto";
import type { ApprovalRequest } from "@ion/adapter-kit";
import type { Judge } from "./judge.js";
import { ruleFor, type Verdict } from "./rules.js";

export { createJudge, type Judge, judgePrompt, parseVerdict } from "./judge.js";
export { ruleFor } from "./rules.js";
export { harnessRunner } from "./runner.js";

type At = { chatId: string; projectId: string; text: string; roots: string[] };
export type Access = { decide(at: At, req: ApprovalRequest): Promise<Verdict> };

/** Auto: rules first, then the judge, at most once per action in a chat. */
export function createAccess(o: {
  judge: Judge;
  home: string;
  ionDirs: string[];
  /** Your decisions that apply in a chat, for the judge (Plan 06). */
  decisionsFor?: (projectId: string, chatId: string) => string[];
}): Access {
  const cache = new Map<string, Verdict>();
  return {
    async decide(at, req) {
      const rule = ruleFor(req, { roots: at.roots, home: o.home, ionDirs: o.ionDirs });
      if (rule) return rule;
      // The same action for the same request in a chat: one judge call.
      const hash = createHash("sha256")
        .update(JSON.stringify([at.text, req.toolName, req.input, o.decisionsFor?.(at.projectId, at.chatId)]))
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
      });
      const verdict: Verdict = { decision: v.allow ? "allow" : "deny", reason: v.reason };
      // A judge that couldn't decide (slow, signed out) is asked again next time.
      if (v.decided !== false) cache.set(key, verdict);
      return verdict;
    },
  };
}
