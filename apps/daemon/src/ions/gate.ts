import type { ApprovalRequest } from "@ion/adapter-kit";
import { ION_ION_TOOLS } from "@ion/schema";
import { ruleFor, type RuleCtx } from "../access/rules.js";
import { fetchVerdict, isWebNamed, isWebSearch, searchVerdict, type TurnWeb, type Verdict } from "./web.js";

/** Why an ion's call was refused, when it isn't a page read. */
const READ_ONLY = "An ion only reads; a thread does the work.";

/** A web call, whatever kind its harness gave it: kind "web", a web tool by name, or Grok's own search. */
const isWeb = (req: ApprovalRequest) => req.kind === "web" || isWebNamed(req);

/** ion's own MCP tools: `mcp__ion__<tool>` (Claude Code) or `ion__<tool>` (Grok). */
const ION_TOOL = new RegExp(`^(mcp__)?ion__(${ION_ION_TOOLS.join("|")})$`);

/**
 * An ion's agent may look and ask ion, nothing else: ion's own tools, its agent's web search, then Auto's read-only
 * rules (commands that only look, reads and searches inside the roots). Everything else is denied, a page read too
 * (only `ionVerdict` can check one). It never asks and never calls the judge: nobody is there to answer.
 */
export function decideForIon(req: ApprovalRequest, c: RuleCtx): "allow" | "deny" {
  if (req.kind === "mcp") return req.mcpServer === "ion" && ION_TOOL.test(req.toolName) ? "allow" : "deny";
  if (isWeb(req)) return isWebSearch(req) ? searchVerdict(req.input).decision : "deny";
  return ruleFor(req, c)?.decision === "allow" ? "allow" : "deny";
}

/**
 * An ion's call, with why when it's refused: a page read only under the web rules (a page this turn found or you
 * gave it, on a public https address, a short query); everything else as `decideForIon`.
 */
export async function ionVerdict(req: ApprovalRequest, c: RuleCtx, web: TurnWeb): Promise<Verdict> {
  if (isWeb(req)) return isWebSearch(req) ? searchVerdict(req.input) : fetchVerdict(req, web);
  return decideForIon(req, c) === "allow" ? { decision: "allow" } : { decision: "deny", reason: READ_ONLY };
}
