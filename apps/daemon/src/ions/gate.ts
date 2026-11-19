import type { ApprovalRequest } from "@ion/adapter-kit";
import { ruleFor, type RuleCtx } from "../access/rules.js";

/** ion's own MCP tools: `mcp__ion__<tool>` (Claude Code) or `ion__<tool>` (Grok). */
const ION_TOOL =
  /^(mcp__)?ion__(projects|search_chats|chat_history|open_needs|memory_list|memory_write|decisions|set_profile|start_thread|ask|report_outcome)$/;

/**
 * An ion's agent may look and ask ion, nothing else: ion's own tools, then Auto's read-only rules (commands that
 * only look, reads and searches inside the roots). Everything else is denied. It never asks and never calls the
 * judge: nobody is there to answer.
 */
export function decideForIon(req: ApprovalRequest, c: RuleCtx): "allow" | "deny" {
  if (req.kind === "mcp") return req.mcpServer === "ion" && ION_TOOL.test(req.toolName) ? "allow" : "deny";
  return ruleFor(req, c)?.decision === "allow" ? "allow" : "deny";
}
