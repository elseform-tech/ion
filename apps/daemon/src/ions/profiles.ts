import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { PROFILE_CHARS, type ProjectEntry } from "@ion/config";
import { stripControl } from "@ion/schema";

const RANKED = 10;

/** One line, no control characters, at most PROFILE_CHARS. */
export const cleanProfile = (s: string): string =>
  stripControl(s).replace(/\s+/g, " ").trim().slice(0, PROFILE_CHARS);

/** A README line that isn't prose: a heading, an image or badge, HTML. */
const notProse = (line: string) => /^(#|!\[|\[!\[|<)/.test(line);

const README_BYTES = 16 * 1024;

/**
 * The head of the project's README.md: only a plain file inside the project (no link out of it, no hard link, FIFO
 * or device), at most 16 KB. Security review, 2026-11-19: a cloned repo's README could be a link to your secrets.
 */
function readmeOf(path: string): string {
  const file = join(path, "README.md");
  let fd: number;
  try {
    // O_NONBLOCK: a FIFO or device named README.md must not block the daemon.
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return "";
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) return "";
    const rel = relative(realpathSync(path), realpathSync(file));
    if (rel.startsWith("..") || isAbsolute(rel)) return "";
    const buf = Buffer.alloc(Math.min(st.size, README_BYTES));
    return buf.toString("utf8", 0, readSync(fd, buf, 0, buf.length, 0));
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

/** The README's first paragraph of prose. */
function firstParagraph(readme: string): string {
  const paragraphs = readme.split(/\r?\n\s*\r?\n/);
  for (const p of paragraphs) {
    const prose = p
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !notProse(l));
    if (prose.length) return prose.join(" ");
  }
  return "";
}

/** What a project is: the config's `profile`, else its README's first paragraph, else "". */
export function profileOf(project: ProjectEntry): string {
  if (project.profile) return cleanProfile(project.profile);
  return cleanProfile(firstParagraph(readmeOf(project.path)));
}

const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

type Rankable = { id: string; name?: string; profile: string; titles: string[] };

/**
 * Project ids, best first, at most 10: how many of the query's words appear in a project's id, name, profile
 * and recent chat titles. Ties keep the order given (most recent activity first).
 */
export function rankProjects(query: string, projects: Rankable[]): string[] {
  const asked = [...words(query)];
  const scored = projects.map((p, i) => {
    const has = words([p.id, p.name ?? "", p.profile, ...p.titles].join(" "));
    return { id: p.id, i, score: asked.filter((w) => has.has(w)).length };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, RANKED).map((s) => s.id);
}
