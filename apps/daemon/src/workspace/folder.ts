import { existsSync, realpathSync, statSync } from "node:fs";
import { lstat, mkdir, mkdtemp, opendir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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
const SECRET_DIRS = [".ssh", ".aws", ".gnupg", ".config", ".local"];
/** System folders: refused with all inside them. */
const SYSTEM_TREES = ["/etc", "/private/etc", "/System", "/bin", "/sbin", "/usr"];
/** System folders refused themselves (what's inside, like a temp folder under /var, may be yours). */
const SYSTEM_ROOTS = ["/var", "/private/var", "/private", "/Applications", "/Users", "/opt"];

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

/**
 * Why a folder in or around your home isn't a project: home, above it, under one of its hidden folders (any depth),
 * iCloud Drive (its sync can damage a .git: re-review of 2e7edd6, 2026-11-23), or your Library; else null.
 */
function homeRefusal(path: string, home: string): string | null {
  if (within(home, path)) return "Pick a project folder, not your home folder or one above it";
  // Another person's home on this Mac (security scan of 3864449, 2026-11-23).
  if (within(path, "/Users") && !within(path, home))
    return "Pick a project folder, not another user's folder";
  if (within(path, home) && path.slice(home.length + 1).startsWith("."))
    return "Pick a project folder, not one in a hidden folder of your home";
  if (within(path, join(home, "Library", "Mobile Documents")))
    return "iCloud Drive can damage a git repo; move the project out of iCloud Drive first";
  if (within(path, join(home, "Library")) || within(path, "/Library"))
    return "Pick a project folder, not one in Library";
  return null;
}

/**
 * Why ion won't add this folder, or null. ion's own: its folders, and any folder that holds one. `repo`: a repo with
 * commits, where ion writes nothing: only the secrets, system and ion's own refusals (Plan 21 final review, M3).
 */
function refusal(path: string, home: string, ionDirs: string[], repo = false): string | null {
  const near = repo ? null : homeRefusal(path, home);
  if (near) return near;
  const secret = path.split(sep).find((part) => SECRET_DIRS.some((d) => same(d, part)));
  if (secret) return `Pick a project folder, not one in ${secret}`;
  if (SYSTEM_TREES.some((d) => within(path, d)) || SYSTEM_ROOTS.some((d) => same(path, d)))
    return "Pick a project folder, not a system folder";
  if (ionDirs.some((d) => within(path, real(d)) || within(real(d), path)))
    return "Pick a project folder, not one of ion's own";
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

/**
 * What a walk of the folder found: the files for the first commit (paths from it, with "/"), how many things were
 * left out, the files too big to commit. The same rule decides both (security scan of 2e7edd6, 2026-11-23).
 */
type Walked = { paths: string[]; left: number; big: string[] };
type Limits = { maxFiles: number; maxBytes: number };

/** An error reading the folder, in a plain line. */
function unreadable(e: unknown, dir: string): Error {
  const code = (e as NodeJS.ErrnoException).code;
  return new Error(code === "EACCES" || code === "EPERM" ? `ion can't read ${dir}` : `Couldn't read ${dir}`);
}

/** A name ion never commits: a key or secret (any letter case), or one with a line break in it. */
const leftName = (name: string) => LEFT_FILE.test(name) || /[\r\n]/.test(name);

/** One file: listed for the first commit, or left out (a secret, an odd name, or too big). */
async function countFile(path: string, root: string, w: Walked, l: Limits): Promise<void> {
  if (leftName(basename(path))) {
    w.left++;
    return;
  }
  const rel = relative(root, path).split(sep).join("/");
  if ((await lstat(path)).size > l.maxBytes) {
    w.left++;
    w.big.push(rel);
    return;
  }
  w.paths.push(rel);
  if (w.paths.length > l.maxFiles)
    throw new Error(
      `Too many files to set up git here (over ${l.maxFiles.toLocaleString("en-US")}). Pick a project folder, or run git init in it yourself`,
    );
}

/** Walks the folder without blocking ion (links aren't followed), stopping at the file limit. */
async function walk(root: string, l: Limits): Promise<Walked> {
  const w: Walked = { paths: [], left: 0, big: [] };
  const visit = async (dir: string): Promise<void> => {
    const d = await opendir(dir).catch((e: unknown) => {
      throw unreadable(e, dir);
    });
    for await (const e of d) {
      const path = join(dir, e.name);
      if (!e.isDirectory()) await countFile(path, root, w, l);
      else if (e.name === ".git") continue;
      else if (LEFT_DIRS.includes(e.name) || /[\r\n]/.test(e.name)) w.left++;
      else await visit(path);
    }
  };
  await visit(root);
  return w;
}

/** A path as a gitignore line matching only that file. */
const exact = (rel: string) => `/${rel.replace(/([\\*?[\]!# ])/g, "\\$1")}`;

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

/**
 * The walk's files your own .gitignore files leave out, asked before anything is written: in the repo when there is
 * one, else through a throwaway repo outside the folder (security scan of 3864449, 2026-11-23: the question's count
 * didn't match what went in).
 */
async function ignoredOf(path: string, listed: string[], repo: boolean): Promise<Set<string>> {
  if (!listed.length) return new Set();
  const scratch = repo ? null : await mkdtemp(join(tmpdir(), "ion-check-"));
  try {
    const where = scratch ? ["--git-dir", scratch, "--work-tree", path] : [];
    if (scratch) await mustGit(["init", "-q", "--bare", scratch], path);
    const input = listed.join("\0");
    const r = await git([...where, "check-ignore", "--stdin", "-z", "--no-index"], path, { input });
    // 1: none ignored.
    if (r.code > 1 || r.code < 0)
      throw new Error(`git check-ignore failed: ${r.stderr.trim().split("\n")[0]}`);
    return new Set(r.stdout.split("\0").filter(Boolean));
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * The walk's files that git would take too (your own .gitignore still counts): untracked and not ignored, exactly as
 * listed (letter case too).
 */
async function addable(path: string, listed: string[]): Promise<string[]> {
  const r = await git(["ls-files", "--others", "--exclude-standard", "-z"], path);
  if (r.code !== 0) throw new Error(`git ls-files failed: ${r.stderr.trim().split("\n")[0]}`);
  const untracked = new Set(r.stdout.split("\0"));
  return listed.filter((p) => untracked.has(p));
}

/**
 * git init (unless the repo is there), ion's excludes (for later only), then the first commit of exactly the files
 * listed, each by its literal path, never `git add -A`; how many went in. A failure removes the .git ion made.
 */
async function firstCommit(path: string, w: Walked, hadGit: boolean): Promise<number> {
  // Your index as it was (a repo with no commits): put back if the setup fails (Plan 21 final review, M11).
  const index = join(path, ".git", "index");
  const kept = hadGit ? await readFile(index).catch(() => null) : null;
  try {
    if (!hadGit) await mustGit(["init", "-q", "-b", "main"], path);
    // Nothing staged before rides along (security scan of 3864449, 2026-11-23): an empty index, your files untouched.
    await mustGit(["read-tree", "--empty"], path);
    await writeExclude(path, w.big);
    const files = await addable(path, w.paths);
    const input = files.map((p) => `:(literal)${p}`).join("\0");
    const add = ["add", "--pathspec-from-file=-", "--pathspec-file-nul"];
    if (files.length) await mustGit(add, path, input);
    const who = await identity(path);
    await mustGit([...who, "commit", "-q", "--allow-empty", "-m", "Start (ion's git setup)"], path);
    return files.length;
  } catch (e) {
    if (!hadGit) await rm(join(path, ".git"), { recursive: true, force: true });
    else if (kept) await writeFile(index, kept).catch(() => undefined);
    throw new Error(`Couldn't set up git here: ${(e as Error).message}`);
  }
}

/** Added already, under this real path or a link to it (re-review of 2e7edd6, 2026-11-23). */
function mustBeNew(c: UserConfig, path: string): void {
  const dup = c.projects.find((p) => same(real(p.path), path));
  if (dup) throw new Error(`Already added: ${dup.id}`);
}

/** A folder inside a repo: that repo, once you say so (never a repo inside a repo). */
function addRepoAbove(
  c: UserConfig,
  top: string,
  o: FolderOpts,
  home: string,
): FolderAdded | Promise<FolderAdded> {
  if (!o.confirm) return { ask: `This folder is in the git repo at ${top}. Add that repo?` };
  return hasCommit(top).then((yes) => {
    const why = refusal(top, home, o.ionDirs, yes);
    if (why) throw new Error(why);
    mustBeNew(c, top);
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
  const top = await repoOf(at);
  const committed = !!top && same(top, at) && (await hasCommit(at));
  const why = refusal(at, home, o.ionDirs, committed);
  if (why) throw new Error(why);
  if (top && !same(top, at)) return addRepoAbove(c, top, o, home);
  mustBeNew(c, at);
  if (committed) return { config: addProject(c, at) };
  const w = await walk(at, { maxFiles: o.maxFiles ?? MAX_FILES, maxBytes: o.maxBytes ?? MAX_BYTES });
  const ignored = await ignoredOf(at, w.paths, Boolean(top));
  const count = w.paths.length - ignored.size;
  const n = `${count} ${count === 1 ? "file" : "files"}`;
  if (!o.confirm) return { ask: `Set up git here? ion makes a first commit of ${n}` };
  const files = await firstCommit(at, w, Boolean(top));
  return { config: addProject(c, at), gitSetUp: { files, left: w.left + w.paths.length - files } };
}
