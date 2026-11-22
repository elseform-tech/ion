import type { ApprovalRequest } from "@ion/adapter-kit";
import { ION_ION_TOOLS } from "@ion/schema";
import { meansToRead, ruleFor, type RuleCtx } from "../access/rules.js";
import { fetchVerdict, isWebNamed, isWebSearch, searchVerdict, type TurnWeb, type Verdict } from "./web.js";

/** Why an ion's call was refused, when it isn't a page read. */
const READ_ONLY = "An ion only reads; a thread does the work.";
/** Why an ion's read was refused where a chat's would go to the judge (the user, 2026-11-22). */
const NOT_FOR_ION = "An ion doesn't read that; a thread can, with your OK.";

/** A web call, whatever kind its harness gave it: kind "web", a web tool by name, or Grok's own search. */
const isWeb = (req: ApprovalRequest) => req.kind === "web" || isWebNamed(req);

/** ion's own MCP tools: `mcp__ion__<tool>` (Claude Code) or `ion__<tool>` (Grok). */
const ION_TOOL = new RegExp(`^(mcp__)?ion__(${ION_ION_TOOLS.join("|")})$`);

/**
 * An ion's agent may look and ask ion, nothing else: ion's own tools, its agent's web search, then Auto's read-only
 * rules with Auto's free reads (the user, 2026-11-22: as a chat reads, inside the roots and out). Everything else is
 * denied, a page read too (only `ionVerdict` can check one), and what a chat's judge would decide: it never asks and
 * never calls the judge, nobody is there to answer.
 */
export function decideForIon(
  req: ApprovalRequest,
  c: RuleCtx,
  served: string[] = [],
  own: string[] = [],
): "allow" | "deny" {
  if (req.kind === "mcp") return mcpForIon(req, served, own);
  if (isWeb(req)) return isWebSearch(req) ? searchVerdict(req.input).decision : "deny";
  return fileVerdict(req, c).decision;
}

/** A file read or command under Auto's rules with free reads; what would go to the judge is refused. */
function fileVerdict(req: ApprovalRequest, c: RuleCtx): Verdict {
  const rule = ruleFor(req, { ...c, freeReads: true });
  if (rule?.decision === "allow") return { decision: "allow" };
  if (!meansToRead(req)) return { decision: "deny", reason: READ_ONLY };
  return { decision: "deny", reason: rule?.reason ?? NOT_FOR_ION };
}

/**
 * An ion's call, with why when it's refused: a page read only under the web rules (a page this turn found or you
 * gave it, on a public https address, a short query); everything else as `decideForIon`.
 */
export async function ionVerdict(
  req: ApprovalRequest,
  c: RuleCtx,
  web: TurnWeb,
  servers: { served: string[]; own: string[] } = { served: [], own: [] },
): Promise<Verdict> {
  if (isWeb(req)) return isWebSearch(req) ? searchVerdict(req.input) : fetchVerdict(req, web);
  if (req.kind === "mcp")
    return mcpForIon(req, servers.served, servers.own) === "allow"
      ? { decision: "allow" }
      : { decision: "deny", reason: READ_ONLY };
  return fileVerdict(req, c);
}

/**
 * An ion's MCP call: ion's own tools; or one of your servers this turn reaches through ion's gateway (decided there),
 * never a name the agent's own has.
 */
function mcpForIon(req: ApprovalRequest, served: string[], own: string[]): "allow" | "deny" {
  if (req.mcpServer === "ion" && ION_TOOL.test(req.toolName)) return "allow";
  return servedBy(req, served) && !servedBy(req, own) ? "allow" : "deny";
}

/** A call on a server ion's gateway serves this turn: by the server the harness names, or the tool's prefix. */
function servedBy(req: ApprovalRequest, names: string[]): boolean {
  const lower = names.map((n) => n.toLowerCase());
  if (req.mcpServer) return req.mcpServer !== "ion" && lower.includes(req.mcpServer.toLowerCase());
  const tool = req.toolName.toLowerCase();
  return lower.some((s) => tool.startsWith(`mcp__${s}__`) || tool.startsWith(`${s}__`));
}
