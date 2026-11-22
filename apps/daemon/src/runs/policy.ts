import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ApprovalRequest } from "@ion/adapter-kit";
import { ION_RUN_TOOLS } from "@ion/schema";

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

/** ion's own MCP tools: `mcp__ion__<tool>` (Claude Code) or `ion__<tool>` (Grok). */
const ION_TOOL = new RegExp(`^(mcp__)?ion__(${ION_RUN_TOOLS.join("|")})$`);
const URL_LIKE = /^[a-z][a-z0-9+.-]+:/i;
const REACHES_OUT = /(^[~/])|(\.\.)/;

/**
 * A Glob pattern is itself a path: the pattern and each of its brace alternatives that is absolute, ~ or ..
 * (braces or extglob alternatives can hide an absolute one) is checked like any other path.
 */
function globPaths(req: ApprovalRequest, k: string, v: string): string[] {
  if (k !== "pattern" || !/glob/i.test(req.toolName)) return [];
  // Escapes removed, then what follows every opening or alternation delimiter (braces, extglob @(a|b), …).
  const plain = v.replaceAll("\\", "");
  const alternatives = [...plain.matchAll(/[{,(|]\s*([^,{}()|]*)/g)].map((m) => m[1]!.trim());
  return [plain, ...alternatives].filter((p) => REACHES_OUT.test(p));
}

function pathsOf(req: ApprovalRequest): string[] {
  const out: string[] = [];
  for (const [k, v] of strings(req.input)) {
    if (PATH_KEY.test(k)) out.push(v);
    out.push(...globPaths(req, k, v));
  }
  return out;
}

/** Where a path that can't be resolved (a link loop, links too deep) is taken to be: outside everything. */
const UNRESOLVED = "/.ion-unresolved-link";

/** A link's target, when `p` is a link (broken or not); else null. */
function linkOf(p: string): string | null {
  try {
    return lstatSync(p).isSymbolicLink() ? readlinkSync(p) : null;
  } catch {
    return null;
  }
}

/**
 * The real path, resolving symlinks; for a file that doesn't exist yet, its nearest existing parent's. A broken link is
 * followed to where it points (task review, 2026-11-22), however deep (40 links at most; past that, outside).
 */
export function realish(p: string, depth = 0): string {
  let dir = p;
  const tail: string[] = [];
  while (!existsSync(dir) && dirname(dir) !== dir) {
    const link = linkOf(dir);
    if (link !== null)
      return depth >= 40 ? UNRESOLVED : realish(join(resolve(dirname(dir), link), ...tail), depth + 1);
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

/** The system temp folder everyone shares: /tmp (and /private/tmp). */
const SYSTEM_TEMP = /^(\/private)?\/tmp(\/|$)/;
/** macOS's per-user temp folder, `/var/folders/<a>/<b>/T`: only your own counts (task review, 2026-11-22). */
const VAR_TEMP = /^(\/private)?\/var\/folders\/[^/]+\/[^/]+\/T$/;

/** Your `$TMPDIR` (real path), when it's your own /var/folders temp folder or under /tmp; else none. */
function namedTemp(): string | null {
  const d = realish(tmpdir()); // $TMPDIR when set (no trailing slash: a real path)
  return VAR_TEMP.test(d) || SYSTEM_TEMP.test(d) ? d : null;
}

/** Inside a system temp folder (links followed): agents write their scratch files there freely (the user, 2026-11-21). */
function inTemp(p: string, roots: string[]): boolean {
  const real = realish(resolve(roots[0] ?? "/", expandHome(p)));
  const named = namedTemp();
  return SYSTEM_TEMP.test(real) || (!!named && inside(real, [named]));
}

/**
 * Reads and searches whose every named path is inside the chat's worktree (symlinks resolved) are allowed; edits too,
 * and in the system temp folders (the user, 2026-11-21: the freedom agents already have, as Codex's workspace-write
 * and Claude Code's sandbox). Anything else (commands, web, MCP, paths elsewhere, or an edit that names no path) is
 * "ask": Auto's rules and judge decide it. Edits to git internals and agent config always ask.
 */
export function decideByPolicy(
  req: ApprovalRequest,
  opts: { roots: string[]; ionMcp?: boolean },
): "allow" | "ask" {
  // ion's own MCP tools answer only about this run's project (the server checks the run's key): allowed by
  // exact name, and only when this run was given ion's server. Any other MCP tool asks.
  if (req.kind === "mcp")
    return opts.ionMcp && req.mcpServer === "ion" && ION_TOOL.test(req.toolName) ? "allow" : "ask";
  const paths = pathsOf(req);
  // A URL (https:, file:, …) in a path field is never "inside the worktree".
  if (paths.length === 0 || paths.some((p) => URL_LIKE.test(p))) return "ask";
  if (req.kind === "edit") return editsFreely(paths, opts.roots) ? "allow" : "ask";
  return ["read", "search"].includes(req.kind) && allInside(paths, opts.roots) ? "allow" : "ask";
}

/** An edit whose every path is in the worktree or a temp folder, none of them a file that makes something run code. */
const editsFreely = (paths: string[], roots: string[]) =>
  !paths.some((p) => runsCode(p, roots)) && paths.every((p) => inside(p, roots) || inTemp(p, roots));

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
