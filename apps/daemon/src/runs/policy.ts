import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ApprovalRequest } from "@ion/adapter-kit";

/** Every string in the input, however deeply nested, with the key it sits under. */
function* strings(value: unknown, key = ""): Generator<[string, string]> {
  if (typeof value === "string") yield [key, value];
  else if (Array.isArray(value)) for (const v of value) yield* strings(v, key);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) yield* strings(v, k);
}

/**
 * Every path a request names: strings under a key ending in "path" (file_path, notebook_path, filePath, …),
 * "locations", or naming a source, destination or folder, at any depth; and a Glob's pattern when it is a path. File content, patterns and queries are never treated as paths.
 */
const PATH_KEY = /(path|locations|destination|dest|target|source|src|dir|directory|cwd|root)$/i;

/** A Glob pattern is itself a path: an absolute, ~ or .. one can reach outside the worktree. */
const isGlobPath = (req: ApprovalRequest, k: string, v: string) =>
  k === "pattern" && /glob/i.test(req.toolName) && /(^[~/])|(\.\.)/.test(v);

function pathsOf(req: ApprovalRequest): string[] {
  const out: string[] = [];
  for (const [k, v] of strings(req.input)) if (PATH_KEY.test(k) || isGlobPath(req, k, v)) out.push(v);
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

const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);

function inside(p: string, roots: string[]): boolean {
  const real = realish(resolve(roots[0] ?? "/", expandHome(p)));
  return roots.some((root) => {
    const rel = relative(realish(root), real);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

const allInside = (paths: string[], roots: string[]) => paths.every((p) => inside(p, roots));

/**
 * Reads, searches and edits whose every named path is inside the chat's worktree (symlinks resolved) are
 * allowed: the worktree is the sandbox. Anything else (commands, web, MCP, paths outside, or an edit that
 * names no path) is "ask": it becomes a need you answer. Edits to git internals and agent config always ask.
 */
export function decideByPolicy(req: ApprovalRequest, opts: { roots: string[] }): "allow" | "ask" {
  const paths = pathsOf(req);
  const inWorktree = paths.length > 0 && allInside(paths, opts.roots);
  if (req.kind === "edit" && paths.some((p) => runsCode(p, opts.roots))) return "ask";
  return ["read", "search", "edit"].includes(req.kind) && inWorktree ? "allow" : "ask";
}

/**
 * Git internals, agent config and tool config can make git, a coding agent or a package manager run code:
 * editing any dot-folder in the worktree, or one of these files, always asks. Case-insensitive (macOS).
 */
const CODE_FILES = new Set([
  ".git",
  ".gitmodules",
  ".gitattributes",
  ".mcp.json",
  ".envrc",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pre-commit-config.yaml",
]);
function runsCode(p: string, roots: string[]): boolean {
  const real = realish(resolve(roots[0] ?? "/", expandHome(p)));
  const root = roots.map(realish).find((r) => !relative(r, real).startsWith(".."));
  const parts = (root ? relative(root, real) : real).toLowerCase().split(/[\\/]+/);
  return (
    CODE_FILES.has(parts.at(-1) ?? "") || parts.slice(0, -1).some((s) => s.startsWith(".") && s !== "..")
  );
}
