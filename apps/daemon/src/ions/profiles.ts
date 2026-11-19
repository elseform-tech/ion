import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectEntry } from "@ion/config";
import { stripControl } from "@ion/schema";

/** A profile is a line or two: what ion chief reads to know what a project is. */
export const PROFILE_CHARS = 300;
const RANKED = 10;

/** One line, no control characters, at most 300 characters. */
export const cleanProfile = (s: string): string =>
  stripControl(s).replace(/\s+/g, " ").trim().slice(0, PROFILE_CHARS);

/** A README line that isn't prose: a heading, an image or badge, HTML. */
const notProse = (line: string) => /^(#|!\[|\[!\[|<)/.test(line);

function readmeOf(path: string): string {
  try {
    return readFileSync(join(path, "README.md"), "utf8");
  } catch {
    return "";
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
