import { type Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import type { ArtifactInfo } from "@ion/schema";

const MAX_ARTIFACTS = 200;
/** The walk visits at most this many entries, so a huge tree can't stall the daemon. */
const MAX_VISITED = 20_000;
const SKIP = new Set([".git", "node_modules"]);
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"]);
const HTML = new Set([".html", ".htm"]);
const TEXT = new Set([
  ".txt",
  ".md",
  ".json",
  ".csv",
  ".tsv",
  ".log",
  ".yml",
  ".yaml",
  ".toml",
  ".xml",
  ".css",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".sh",
  ".sql",
  ".ini",
  ".env",
  "",
]);

function kindOf(name: string): ArtifactInfo["kind"] {
  const ext = extname(name).toLowerCase();
  if (IMAGE.has(ext)) return "image";
  if (HTML.has(ext)) return "html";
  return TEXT.has(ext) ? "text" : "binary";
}

/**
 * The files a chat's runs made: everything under the worktree modified at or after `since` (ISO), ignored
 * outputs included, newest first, at most 200. Links are never followed or listed, `.git` and `node_modules`
 * are skipped. Newest-first needs every candidate, so the walk is bounded (20,000 entries), then sorted and cut.
 */
export async function listArtifacts(worktree: string, since: string): Promise<ArtifactInfo[]> {
  const from = Date.parse(since);
  const found: ArtifactInfo[] = [];
  const dirs = [""];
  const budget = { left: MAX_VISITED };
  while (dirs.length && budget.left > 0) await walkDir(worktree, dirs.pop()!, { dirs, found, from, budget });
  return found.sort((a, b) => b.changedAt.localeCompare(a.changedAt)).slice(0, MAX_ARTIFACTS);
}

type Walk = { dirs: string[]; found: ArtifactInfo[]; from: number; budget: { left: number } };

/** One folder: queue its subfolders, collect its recent files. */
async function walkDir(worktree: string, rel: string, w: Walk): Promise<void> {
  const entries = (await readDir(join(worktree, rel))).slice(0, Math.max(0, w.budget.left));
  w.budget.left -= entries.length;
  for (const e of entries) {
    const path = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory() && !SKIP.has(e.name)) w.dirs.push(path);
    if (e.isFile()) await collect(worktree, path, w);
  }
}

async function collect(worktree: string, path: string, w: Walk): Promise<void> {
  const info = await describe(worktree, path, w.from);
  if (info) w.found.push(info);
}

/** A folder's entries (links show as links, never as what they point to); none if it's gone or unreadable. */
async function readDir(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function describe(worktree: string, path: string, from: number): Promise<ArtifactInfo | null> {
  try {
    const s = await lstat(join(worktree, path));
    if (!s.isFile() || s.mtimeMs < from) return null;
    return { path, size: s.size, changedAt: s.mtime.toISOString(), kind: kindOf(path) };
  } catch {
    return null;
  }
}
