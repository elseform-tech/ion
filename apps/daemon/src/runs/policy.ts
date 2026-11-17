import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ApprovalRequest, Decision } from "@ion/adapter-kit";

const looksLikePath = (v: string) => v.startsWith("/") || v.startsWith("~") || v.includes("../");

/** Every path a request names: any input field whose name ends in "path" (file_path, filePath, …) plus ACP `locations`. */
function pathsOf(req: ApprovalRequest): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(req.input)) {
    if (typeof v !== "string") continue;
    // Named path fields, plus anything that looks like a path elsewhere (absolute, home, or climbing out).
    if (/path$/i.test(k) || looksLikePath(v)) out.push(v);
  }
  return [...out, ...locationsOf(req.input)];
}

/** ACP `locations`, as plain strings. */
const locationsOf = (input: Record<string, unknown>): string[] =>
  Array.isArray(input.locations) ? input.locations.filter((l): l is string => typeof l === "string") : [];

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
  const expanded = p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
  const real = realish(resolve(roots[0] ?? "/", expanded));
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
    search: named,
    edit: opts.allowEdits && named,
  };
  return rules[req.kind] === true ? "allow" : "deny";
}
