import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ApprovalRequest, Decision } from "@ion/adapter-kit";

/** Absolute, home-relative, or containing a `..` segment (either separator). */
const looksLikePath = (v: string) =>
  v.startsWith("/") || v.startsWith("~") || v.split(/[\\/]/).includes("..");

/** Every string in the input, however deeply nested, with the key it sits under. */
function* strings(value: unknown, key = ""): Generator<[string, string]> {
  if (typeof value === "string") yield [key, value];
  else if (Array.isArray(value)) for (const v of value) yield* strings(v, key);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) yield* strings(v, k);
}

/**
 * Every path a request names: strings under a key ending in "path" or "locations", plus any string anywhere
 * that looks like a path (absolute, ~, or with a `..` segment).
 */
function pathsOf(req: ApprovalRequest): string[] {
  const out: string[] = [];
  for (const [k, v] of strings(req.input)) if (/(path|locations)$/i.test(k) || looksLikePath(v)) out.push(v);
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
