import { existsSync, realpathSync, statSync } from "node:fs";
import { lstat, mkdir, opendir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { addProject, type UserConfig } from "@ion/config";
import { git } from "./git.js";
import { expandHome, identity, mustGit } from "./projects.js";

/**
 * Adding a folder of yours (Plan 21; review of Plan 21 Task 2 and a security scan, 2026-11-23). `home`: your home
 * folder (tests set one); `ionDirs`: ion's own folders; `confirm`: you said yes to ion's question.
 */
export type FolderOpts = {
  home?: string;
  ionDirs: string[];
  confirm?: boolean;
  maxFiles?: number;
  maxBytes?: number;
};

/** Added (with ion's git setup: what went in its first commit, and how much was left out), or ion's question first. */
export type FolderAdded =
  | { config: UserConfig; gitSetUp?: { files: number; left: number } }
  | { ask: string };

/** At most this many files get ion's git setup: a bigger folder is refused at once, never committed for minutes. */
const MAX_FILES = 20_000;
/** A file bigger than this is left out of the first commit. */
const MAX_BYTES = 50 * 1024 * 1024;

/** Folders that hold keys and settings, refused wherever they are. */
const SECRET_DIRS = [".ssh", ".aws", ".gnupg", ".config", ".local", "Library"];
/** System folders: refused with all inside them. */
const SYSTEM_TREES = ["/etc", "/private/etc", "/System", "/bin", "/sbin", "/usr"];
/** System folders refused themselves (what's inside, like a temp folder under /var, may be yours). */
const SYSTEM_ROOTS = ["/var", "/private/var", "/private", "/Library", "/Applications", "/Users", "/opt"];

/** Never in the first commit: dependencies and build output (folders), keys and secrets (files). */
const LEFT_DIRS = [
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".gradle",
  ".cache",
];
const LEFT_FILES = [".env*", "*.pem", "*.key", "id_*", "credentials*", ".DS_Store"];
const LEFT_FILE = /^(\.env.*|.*\.pem|.*\.key|id_.*|credentials.*|\.DS_Store)$/i;

/** Paths as the file system compares them: macOS's is case-insensitive. */
const fold = (p: string) => (process.platform === "darwin" ? p.toLowerCase() : p);
const same = (a: string, b: string) => fold(a) === fold(b);
/** `p` is `dir` or inside it. */
const within = (p: string, dir: string) =>
  same(p, dir) || fold(p).startsWith(fold(dir.endsWith(sep) ? dir : `${dir}${sep}`));
/** A path's real form (links resolved, the disk's letter case), or the path itself when it isn't there. */
const real = (p: string) => (existsSync(p) ? realpathSync.native(p) : p);

/** Why ion won't add this folder, or null. */
function refusal(path: string, home: string, ionDirs: string[]): string | null {
  if (within(home, path)) return "Pick a project folder, not your home folder or one above it";
  if (same(dirname(path), home) && basename(path).startsWith("."))
    return "Pick a project folder, not a hidden folder in your home";
  const secret = path.split(sep).find((part) => SECRET_DIRS.some((d) => same(d, part)));
  if (secret) return `Pick a project folder, not one in ${secret}`;
  if (SYSTEM_TREES.some((d) => within(path, d)) || SYSTEM_ROOTS.some((d) => same(path, d)))
    return "Pick a project folder, not a system folder";
  if (ionDirs.some((d) => within(path, real(d)))) return "Pick a project folder, not one of ion's own";
  return null;
}

/** The folder you named, by its real path; refused plainly when it isn't one. */
function folderAt(path: string): string {
  const abs = resolve(expandHome(path.trim()));
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`No folder at ${path}`);
  return realpathSync.native(abs);
}

/** The repo the folder is in (its top folder, real path), or null. */
async function repoOf(path: string): Promise<string | null> {
  const r = await git(["rev-parse", "--show-toplevel"], path);
  return r.code === 0 && r.stdout.trim() ? real(r.stdout.trim()) : null;
}

const hasCommit = async (path: string) =>
  (await git(["rev-parse", "--verify", "--quiet", "HEAD"], path)).code === 0;

/** What a walk of the folder found: files for the first commit, things left out, files too big to commit. */
type Walked = { files: number; left: number; big: string[] };
type Limits = { maxFiles: number; maxBytes: number };

/** An error reading the folder, in a plain line. */
function unreadable(e: unknown, dir: string): Error {
  const code = (e as NodeJS.ErrnoException).code;
  return new Error(code === "EACCES" || code === "EPERM" ? `ion can't read ${dir}` : `Couldn't read ${dir}`);
}

/** One file: counted, or left out (a secret, or too big). */
async function countFile(path: string, root: string, w: Walked, l: Limits): Promise<void> {
  if (LEFT_FILE.test(basename(path))) {
    w.left++;
    return;
  }
  if ((await lstat(path)).size > l.maxBytes) {
    w.left++;
    w.big.push(relative(root, path));
    return;
  }
  if (++w.files > l.maxFiles)
    throw new Error(
      `Too many files to set up git here (over ${l.maxFiles.toLocaleString("en-US")}). Pick a project folder, or run git init in it yourself`,
    );
}

/** Walks the folder without blocking ion (links aren't followed), stopping at the file limit. */
async function walk(root: string, l: Limits): Promise<Walked> {
  const w: Walked = { files: 0, left: 0, big: [] };
  const visit = async (dir: string): Promise<void> => {
    const d = await opendir(dir).catch((e: unknown) => {
      throw unreadable(e, dir);
    });
    for await (const e of d) {
      const path = join(dir, e.name);
      if (!e.isDirectory()) await countFile(path, root, w, l);
      else if (e.name === ".git") continue;
      else if (LEFT_DIRS.includes(e.name)) w.left++;
      else await visit(path);
    }
  };
  await visit(root);
  return w;
}

/** A path as a gitignore line matching only that file. */
const exact = (rel: string) =>
  `/${rel
    .split(sep)
    .join("/")
    .replace(/([\\*?[\]!# ])/g, "\\$1")}`;

/** ion's lines in the repo's own exclude file (never committed; your files unchanged). */
async function writeExclude(path: string, big: string[]): Promise<void> {
  const file = join(path, ".git", "info", "exclude");
  await mkdir(dirname(file), { recursive: true });
  const before = await readFile(file, "utf8").catch(() => "");
  const ours = [
    "# ion's git setup: left out of the first commit",
    ...LEFT_DIRS.map((d) => `${d}/`),
    ...LEFT_FILES,
    ...big.map(exact),
  ];
  await writeFile(file, `${before}${before && !before.endsWith("\n") ? "\n" : ""}${ours.join("\n")}\n`);
}

/** git init (unless the repo is there), ion's excludes, then the first commit; a failure removes the .git ion made. */
async function firstCommit(path: string, w: Walked, hadGit: boolean): Promise<void> {
  try {
    if (!hadGit) await mustGit(["init", "-q", "-b", "main"], path);
    await writeExclude(path, w.big);
    await mustGit(["add", "-A"], path);
    const who = await identity(path);
    await mustGit([...who, "commit", "-q", "--allow-empty", "-m", "Start (ion's git setup)"], path);
  } catch (e) {
    if (!hadGit) await rm(join(path, ".git"), { recursive: true, force: true });
    throw new Error(`Couldn't set up git here: ${(e as Error).message}`);
  }
}

/** A folder inside a repo: that repo, once you say so (never a repo inside a repo). */
function addRepoAbove(
  c: UserConfig,
  top: string,
  o: FolderOpts,
  home: string,
): FolderAdded | Promise<FolderAdded> {
  if (!o.confirm) return { ask: `This folder is in the git repo at ${top}. Add that repo?` };
  const why = refusal(top, home, o.ionDirs);
  if (why) throw new Error(why);
  return hasCommit(top).then((yes) => {
    if (!yes) throw new Error(`The git repo at ${top} has no commits yet. Make one there, then add it`);
    return { config: addProject(c, top) };
  });
}

/**
 * Adds a folder of yours (the app's Pick a folder, `ion projects add`), by its real path. A repo is added as it is;
 * a folder inside one offers that repo; any other folder (or a repo with no commits) gets ion's git setup once you
 * confirm: a first commit of your files, without secrets, dependencies, build output or big files. Your home, above
 * it, its hidden folders, secrets folders, system folders and ion's own are refused before anything is touched.
 */
export async function addFolder(c: UserConfig, path: string, o: FolderOpts): Promise<FolderAdded> {
  const at = folderAt(path);
  const home = real(o.home ?? homedir());
  const why = refusal(at, home, o.ionDirs);
  if (why) throw new Error(why);
  const top = await repoOf(at);
  if (top && !same(top, at)) return addRepoAbove(c, top, o, home);
  if (top && (await hasCommit(at))) return { config: addProject(c, at) };
  if (c.projects.some((p) => same(p.path, at))) throw new Error(`Already added: ${at}`);
  const w = await walk(at, { maxFiles: o.maxFiles ?? MAX_FILES, maxBytes: o.maxBytes ?? MAX_BYTES });
  const n = `${w.files} ${w.files === 1 ? "file" : "files"}`;
  if (!o.confirm) return { ask: `Set up git here? ion makes a first commit of ${n}` };
  await firstCommit(at, w, Boolean(top));
  return { config: addProject(c, at), gitSetUp: { files: w.files, left: w.left } };
}
