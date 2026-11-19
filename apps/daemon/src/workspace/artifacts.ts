import { type Dirent } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { extname, join } from "node:path";
import type { ArtifactInfo } from "@ion/schema";

const MAX_ARTIFACTS = 200;
/** The walk visits at most this many entries, so a huge tree can't stall the daemon. */
const MAX_VISITED = 20_000;
const SKIP = new Set([".git", "node_modules"]);
/** The images the preview shows, by extension: the list and the preview agree. SVG is text (markup, never rendered). */
export const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
};
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
  ".svg",
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
  if (IMAGE_TYPES[ext]) return "image";
  if (HTML.has(ext)) return "html";
  return TEXT.has(ext) ? "text" : "binary";
}

/**
 * The files a chat's runs made: everything under the worktree modified at or after `since` (ISO), ignored
 * outputs included, newest first, at most 200. Links are never followed or listed, `.git` and `node_modules`
 * are skipped. Newest-first needs every candidate, so the walk is bounded (20,000 entries), then sorted and cut.
 */
export async function listArtifacts(
  worktree: string,
  since: string,
  maxVisited = MAX_VISITED,
): Promise<ArtifactInfo[]> {
  const from = Date.parse(since);
  if (Number.isNaN(from)) return [];
  const found: ArtifactInfo[] = [];
  const dirs = [""];
  const budget = { left: maxVisited };
  while (dirs.length && budget.left > 0)
    await walkDir(worktree, dirs.shift()!, { dirs, found, from, budget });
  return found.sort((a, b) => b.changedAt.localeCompare(a.changedAt)).slice(0, MAX_ARTIFACTS);
}

type Walk = { dirs: string[]; found: ArtifactInfo[]; from: number; budget: { left: number } };

/** One folder: queue its subfolders, collect its recent files. */
async function walkDir(worktree: string, rel: string, w: Walk): Promise<void> {
  const entries = await readDir(join(worktree, rel), w.budget.left);
  w.budget.left -= entries.length;
  for (const e of entries) {
    const path = rel ? `${rel}/${e.name}` : e.name;
    if (SKIP.has(e.name)) continue;
    if (e.isDirectory()) w.dirs.push(path);
    else if (e.isFile()) await collect(worktree, path, w);
  }
}

async function collect(worktree: string, path: string, w: Walk): Promise<void> {
  const info = await describe(worktree, path, w.from);
  if (info) w.found.push(info);
}

/**
 * Up to `limit` of a folder's entries, streamed so a folder with millions of files isn't read in full (links
 * show as links, never as what they point to); none if it's gone or unreadable.
 */
async function readDir(dir: string, limit: number): Promise<Dirent[]> {
  const out: Dirent[] = [];
  if (limit <= 0) return out;
  try {
    for await (const e of await opendir(dir)) {
      out.push(e);
      if (out.length >= limit) break; // the iterator closes the handle
    }
  } catch {
    // gone or unreadable: keep what was read
  }
  return out;
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
