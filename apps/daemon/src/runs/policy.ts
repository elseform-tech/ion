import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ApprovalRequest, Decision } from "@ion/adapter-kit";

/** Every path a request names: any input field whose name ends in "path" (file_path, filePath, …) plus ACP `locations`. */
function pathsOf(req: ApprovalRequest): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(req.input)) if (/path$/i.test(k) && typeof v === "string") out.push(v);
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
  const named = paths.length > 0 && allInside(paths, opts.roots);
  const rules: Record<string, boolean> = {
    read: named,
    // A search without a path searches the project (the agent's working folder).
    search: allInside(paths, opts.roots),
    edit: opts.allowEdits && named,
  };
  return rules[req.kind] === true ? "allow" : "deny";
}
