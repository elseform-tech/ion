import { isAbsolute, relative, resolve } from "node:path";
import type { ApprovalRequest, Decision } from "@ion/adapter-kit";

const str = (x: unknown) => (typeof x === "string" ? x : null);

/** True when the request names a path and it's outside every project root. */
function outsideProject(req: ApprovalRequest, roots: string[]): boolean {
  const p = str(req.input.file_path) ?? str(req.input.notebook_path) ?? str(req.input.path);
  if (!p) return false;
  return !roots.some((root) => {
    const rel = relative(root, resolve(root, p));
    return !rel.startsWith("..") && !isAbsolute(rel);
  });
}

/**
 * Plan 02's stand-in for "Needs you": reads and searches are fine; edits only with --allow-edits and only
 * inside the project; everything else (commands, web, MCP) is denied. Plan 03 turns denials into pins.
 */
export function decideByPolicy(
  req: ApprovalRequest,
  opts: { allowEdits: boolean; roots: string[] },
): Decision {
  if (req.kind === "read" || req.kind === "search") return "allow";
  if (req.kind === "edit") return opts.allowEdits && !outsideProject(req, opts.roots) ? "allow" : "deny";
  return "deny";
}
