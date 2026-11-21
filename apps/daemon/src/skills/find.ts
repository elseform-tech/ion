import {
  closeSync,
  constants,
  type Dirent,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { type SkillWhose, stripControl } from "@ion/schema";

const MAX_MD = 256 * 1024;
const MAX_FILES = 100;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 4;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 300;
/** Entries looked at in one skills folder (every file, folder, dotfile and socket counts). */
const MAX_ENTRIES = 5000;

/** What's left of a skills folder's entries to look at. */
type Budget = { left: number };

/** `exec`: its owner may run it (a script), kept when it's copied for a run. */
type SkillFile = { rel: string; bytes: Buffer; exec: boolean };

/** A skill as found: its folder (home-shortened, also its id), SKILL.md's text, and its other files. */
export type FoundSkill = {
  id: string;
  name: string;
  description: string;
  whose: SkillWhose;
  where: string;
  /** SKILL.md after its front matter. */
  body: string;
  /** In a project's own folder (written by the repo, not you): the project's folder name. */
  project?: string;
  md: Buffer;
  files: SkillFile[];
};

/** Where each agent keeps its skills: in your home, and in a project. */
const IN_HOME: [SkillWhose, string][] = [
  ["claude", ".claude/skills"],
  ["codex", ".codex/skills"],
  ["opencode", ".config/opencode/skills"],
  ["shared", ".agents/skills"],
];
const IN_PROJECT: [SkillWhose, string][] = [
  ["claude", ".claude/skills"],
  ["opencode", ".opencode/skills"],
  ["shared", ".agents/skills"],
];

/**
 * A regular file's bytes and whether its owner may run it (never through a link, never a FIFO or device), up to
 * `max`; null otherwise.
 */
function readRegular(file: string, max: number): { bytes: Buffer; exec: boolean } | null {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(st.size);
    return { bytes: buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)), exec: (st.mode & 0o100) !== 0 };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

const inside = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/**
 * A folder's real path, when ion may read it: reached without links, or through links that end inside your home
 * (never /etc or another user's). Null for anything else, or a folder that isn't there.
 */
function realDir(dir: string, base: string, homeReal: string): string | null {
  try {
    const real = realpathSync(dir);
    if (!statSync(real).isDirectory()) return null;
    if (inside(real, homeReal)) return real;
    return real === join(realpathSync(base), relative(base, dir)) ? real : null;
  } catch {
    return null;
  }
}

/** SKILL.md in any case: only the top one is the skill's; one deeper would be another skill nobody turned on. */
const SKILL_MD = /^skill\.md$/i;

/**
 * A skill's other files (no dotfiles, no links, no other SKILL.md), or null when it's too big to pass along or its
 * skills folder ran out of entries to look at.
 */
function filesOf(root: string, budget: Budget): SkillFile[] | null {
  const out: SkillFile[] = [];
  let bytes = 0;
  const file = (path: string): boolean => {
    const b = readRegular(path, MAX_BYTES);
    bytes += b?.bytes.length ?? 0;
    if (!b || bytes > MAX_BYTES || out.length >= MAX_FILES) return false;
    out.push({ rel: relative(root, path).split(sep).join("/"), ...b });
    return true;
  };
  const walk = (dir: string, depth: number): boolean =>
    readdirSync(dir, { withFileTypes: true }).every((e) => {
      if (--budget.left < 0) return false;
      if (e.name.startsWith(".") || SKILL_MD.test(e.name)) return true;
      const path = join(dir, e.name);
      if (e.isDirectory()) return depth < MAX_DEPTH && walk(path, depth + 1);
      return !e.isFile() || file(path);
    });
  try {
    return walk(root, 0) ? out.sort((x, y) => (x.rel < y.rel ? -1 : 1)) : null;
  } catch {
    return null;
  }
}

const unquote = (v: string) => {
  const q = v[0];
  if (v.length < 2 || (q !== '"' && q !== "'") || v.at(-1) !== q) return v;
  const inner = v.slice(1, -1);
  return q === '"' ? inner.replaceAll('\\"', '"') : inner.replaceAll("''", "'");
};

/** A block scalar's lines (`>` folds them into one, `|` keeps them), from `i` while they're indented or blank. */
function block(lines: string[], i: number, fold: boolean): { text: string; next: number } {
  const got: string[] = [];
  let j = i;
  for (; j < lines.length && (/^\s/.test(lines[j]!) || lines[j] === ""); j++) got.push(lines[j]!.trim());
  return { text: got.join(fold ? " " : "\n"), next: j };
}

/** The top-level `key: value`s (a `>` or `|` block read whole; nested keys skipped). */
function fieldsOf(lines: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const kv = /^([A-Za-z][\w-]*):(.*)$/.exec(lines[i]!);
    i++;
    if (!kv) continue;
    const v = kv[2]!.trim();
    if (!/^[>|][+-]?$/.test(v)) {
      fields[kv[1]!] = unquote(v);
      continue;
    }
    const b = block(lines, i, v.startsWith(">"));
    fields[kv[1]!] = b.text;
    i = b.next;
  }
  return fields;
}

/** SKILL.md's front matter (between `---` lines at its top) and what follows it. */
function frontMatter(text: string): { fields: Record<string, string>; body: string } {
  const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const end = lines[0]?.trim() === "---" ? lines.findIndex((l, i) => i > 0 && l.trim() === "---") : -1;
  if (end < 0) return { fields: {}, body: text };
  return {
    fields: fieldsOf(lines.slice(1, end)),
    body: text
      .split("\n")
      .slice(end + 1)
      .join("\n"),
  };
}

const clean = (s: string, max: number) => stripControl(s.replace(/\s+/g, " ")).trim().slice(0, max);

/** `~/…` for a path in your home. */
const shorten = (path: string, home: string) => (inside(path, home) ? `~/${relative(home, path)}` : path);

function readSkill(o: {
  dir: string;
  base: string;
  whose: SkillWhose;
  home: string;
  homeReal: string;
  budget: Budget;
}): FoundSkill | null {
  const real = realDir(o.dir, o.base, o.homeReal);
  const md = real ? (readRegular(join(real, "SKILL.md"), MAX_MD)?.bytes ?? null) : null;
  const files = real && md ? filesOf(real, o.budget) : null;
  if (!md || !files) return null;
  const { fields, body } = frontMatter(md.toString("utf8"));
  const where = shorten(o.dir, o.home);
  const name = clean(fields.name ?? "", MAX_NAME) || clean(basename(o.dir), MAX_NAME);
  const description = clean(fields.description ?? "", MAX_DESCRIPTION);
  return { id: where, name, description, whose: o.whose, where, body, md, files };
}

const realOr = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** Each agent's skill folders in your home and in these projects (and ion's own), each once. */
/** A skill in a project's own folder, marked as the repo's. */
const withProject = (s: FoundSkill, r: Root): FoundSkill => (r.project ? { ...s, project: r.project } : s);

type Root = { whose: SkillWhose; base: string; dir: string; project?: string };
const rootsOf = (home: string, projects: string[], ionDir?: string): Root[] =>
  [
    ...(ionDir ? [{ whose: "ion" as const, base: dirname(ionDir), dir: ionDir }] : []),
    ...IN_HOME.map(([whose, rel]) => ({ whose, base: home, dir: join(home, rel) })),
    ...projects.flatMap((p) =>
      IN_PROJECT.map(([whose, rel]) => ({ whose, base: p, dir: join(p, rel), project: basename(p) })),
    ),
  ].filter((r, i, all) => all.findIndex((x) => x.dir === r.dir) === i);

/** A skill folder on its own (one being added): read as ion reads any skill, or null when it isn't one. */
export function readSkillFolder(dir: string, home: string): FoundSkill | null {
  const base = dirname(dir);
  return readSkill({ dir, base, whose: "ion", home, homeReal: realOr(home), budget: { left: MAX_ENTRIES } });
}

/**
 * Every skill in your agents' folders and in these projects' folders (and ion's own, `ionDir`): each a folder with a
 * SKILL.md.
 */
export function findSkills(home: string, projects: string[], ionDir?: string): FoundSkill[] {
  const homeReal = realOr(home);
  return rootsOf(home, projects, ionDir).flatMap((r) => {
    const real = realDir(r.dir, r.base, homeReal);
    const budget = { left: MAX_ENTRIES };
    const out: FoundSkill[] = [];
    for (const e of real ? entriesOf(real) : []) {
      if (--budget.left < 0) break;
      if (e.name.startsWith(".") || !(e.isDirectory() || e.isSymbolicLink())) continue;
      const s = readSkill({ dir: join(r.dir, e.name), base: r.base, whose: r.whose, home, homeReal, budget });
      if (s) out.push(withProject(s, r));
    }
    return out;
  });
}

/** A folder's entries; none when it can't be read (no permission): finding skills never fails. */
function entriesOf(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
