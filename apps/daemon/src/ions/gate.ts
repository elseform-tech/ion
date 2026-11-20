import type { ApprovalRequest } from "@ion/adapter-kit";
import { ION_ION_TOOLS } from "@ion/schema";
import { ruleFor, type RuleCtx } from "../access/rules.js";

/** ion's own MCP tools: `mcp__ion__<tool>` (Claude Code) or `ion__<tool>` (Grok). */
const ION_TOOL = new RegExp(`^(mcp__)?ion__(${ION_ION_TOOLS.join("|")})$`);

/**
 * An ion's agent may look and ask ion, nothing else: ion's own tools, then Auto's read-only rules (commands that
 * only look, reads and searches inside the roots). Everything else is denied. It never asks and never calls the
 * judge: nobody is there to answer.
 */
export function decideForIon(req: ApprovalRequest, c: RuleCtx): "allow" | "deny" {
  if (req.kind === "mcp") return req.mcpServer === "ion" && ION_TOOL.test(req.toolName) ? "allow" : "deny";
  return ruleFor(req, c)?.decision === "allow" ? "allow" : "deny";
}
