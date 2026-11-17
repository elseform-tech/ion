import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ApprovalRequest, Decision } from "@ion/adapter-kit";

const PATH_FIELDS = ["file_path", "notebook_path", "path"];

/** Every path a request names: the usual input fields plus ACP `locations`. */
function pathsOf(req: ApprovalRequest): string[] {
  const out: string[] = [];
  for (const f of PATH_FIELDS) if (typeof req.input[f] === "string") out.push(req.input[f] as string);
  const locations = req.input.locations;
  if (Array.isArray(locations)) for (const l of locations) if (typeof l === "string") out.push(l);
  return out;
}

/** The real path, resolving symlinks; for a file that doesn't exist yet, its nearest existing parent's. */
function realish(p: string): string {
  let dir = p;
  const tail: string[] = [];
  while (!existsSync(dir) && dirname(dir) !== dir) {
    tail.unshift(basename(dir));
    dir = dirname(dir);
  }
  try {
    return join(realpathSync(dir), ...tail);
  } catch {
    return p;
  }
}

function inside(p: string, roots: string[]): boolean {
  const real = realish(resolve(roots[0] ?? "/", p));
  return roots.some((root) => {
    const rel = relative(realish(root), real);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

const allInside = (paths: string[], roots: string[]) => paths.every((p) => inside(p, roots));

/**
 * Plan 02's stand-in for "Needs you". Reads and searches: fine inside the project. Edits: only with
 * --allow-edits, only inside the project, and only when the request names its paths (fail closed).
 * Symlinks are resolved first. Everything else (commands, web, MCP) is denied. Plan 03 turns denials into pins.
 */
export function decideByPolicy(
  req: ApprovalRequest,
  opts: { allowEdits: boolean; roots: string[] },
): Decision {
  const paths = pathsOf(req);
  if (req.kind === "read" || req.kind === "search") return allInside(paths, opts.roots) ? "allow" : "deny";
  if (req.kind === "edit")
    return opts.allowEdits && paths.length > 0 && allInside(paths, opts.roots) ? "allow" : "deny";
  return "deny";
}
