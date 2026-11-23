import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { addProject, DEFAULT_PROJECT, projectIdOf, projectNameError, type UserConfig } from "@ion/config";
import { git } from "./git.js";

const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);

/** A repo ion makes for you: your git identity applies (nothing a run wrote is in a folder that's just been made). */
const yours = { yours: true };

async function mustGit(args: string[], cwd: string): Promise<string> {
  const r = await git(args, cwd, yours);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim().split("\n")[0]}`);
  return r.stdout.trim();
}

/** ion signs a commit only when you have no git identity. */
async function identity(path: string): Promise<string[]> {
  const email = (await git(["config", "user.email"], path, yours)).stdout.trim();
  return email ? [] : ["-c", "user.name=ion", "-c", "user.email=ion@localhost"];
}

/** A new git repo with one empty commit (worktrees need one). */
async function initRepo(path: string): Promise<void> {
  mkdirSync(path, { recursive: true, mode: 0o755 });
  await mustGit(["init", "-q", "-b", "main"], path);
  await mustGit([...(await identity(path)), "commit", "-q", "--allow-empty", "-m", "Start"], path);
}

/** At most this many files get ion's git setup: a bigger folder is refused at once, never committed for minutes. */
const MAX_FILES = 20_000;

/** Whether the folder holds more than `max` files (stops counting there; links aren't followed). */
function tooMany(dir: string, max: number): boolean {
  let n = 0;
  const walk = (d: string): boolean => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (walk(join(d, e.name))) return true;
      } else if (++n > max) return true;
    }
    return false;
  };
  return walk(dir);
}

/**
 * ion's git setup for a folder of yours that isn't a git repo (Plan 21): a new repo with your files in its first
 * commit, so a chat's worktree has them. Refused before anything is written when it's too big.
 */
async function setUpGit(path: string, maxFiles: number): Promise<void> {
  if (tooMany(path, maxFiles))
    throw new Error(
      `Too many files to set up git here (over ${maxFiles.toLocaleString("en-US")}). Pick a project folder, or run git init in it yourself`,
    );
  await mustGit(["init", "-q", "-b", "main"], path);
  await mustGit(["add", "-A"], path);
  await mustGit(
    [...(await identity(path)), "commit", "-q", "--allow-empty", "-m", "Start (ion's git setup)"],
    path,
  );
}

/**
 * Adds a folder of yours (the app's Pick a folder, `ion projects add`). One that isn't a git repo gets ion's git
 * setup first (`gitSetUp`). Your home folder, or one above it, is refused: it isn't a project.
 */
export async function addFolder(
  c: UserConfig,
  path: string,
  o: { maxFiles?: number } = {},
): Promise<{ config: UserConfig; gitSetUp: boolean }> {
  const abs = resolve(expandHome(path.trim()));
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`No folder at ${path}`);
  const home = homedir();
  if (abs === home || home.startsWith(abs.endsWith(sep) ? abs : `${abs}${sep}`))
    throw new Error("Pick a project folder, not your home folder");
  const gitSetUp = !existsSync(join(abs, ".git"));
  if (gitSetUp) {
    if (c.projects.some((p) => p.path === abs)) throw new Error(`Already added: ${abs}`);
    await setUpGit(abs, o.maxFiles ?? MAX_FILES);
  }
  return { config: addProject(c, abs), gitSetUp };
}

/**
 * Makes the project `<folders.projects>/<name>` (a new git repo) and adds it. A folder that's already a git
 * repo is added as it is; any other folder there is refused, never touched.
 */
export async function createProject(
  c: UserConfig,
  name: string,
): Promise<{ config: UserConfig; id: string }> {
  // Any name: its id (and folder) is made from it; the name shows as you typed it when that differs.
  const shown = name.trim().slice(0, 60);
  const id = projectIdOf(shown);
  if (!id) throw new Error("Give the project a name");
  const bad = projectNameError(id);
  if (bad) throw new Error(bad);
  if (c.projects.some((p) => p.id === id)) throw new Error(`A project named ${id} already exists`);
  const path = join(expandHome(c.folders.projects), id);
  if (!existsSync(path)) await initRepo(path);
  else if (!existsSync(join(path, ".git"))) throw new Error(`Folder exists and isn't a git repo: ${path}`);
  const added = addProject(c, path);
  const config =
    shown === id
      ? added
      : { ...added, projects: added.projects.map((p) => (p.path === path ? { ...p, name: shown } : p)) };
  return { config, id: config.projects.find((p) => p.path === path)!.id };
}

/** The built-in `default` project, made the first time; ion (the chief) doesn't read it unless you say so. */
export async function ensureDefaultProject(c: UserConfig): Promise<UserConfig> {
  if (c.projects.some((p) => p.id === DEFAULT_PROJECT)) return c;
  const { config } = await createProject(c, DEFAULT_PROJECT);
  return {
    ...config,
    projects: config.projects.map((p) => (p.id === DEFAULT_PROJECT ? { ...p, shareWithIon: false } : p)),
  };
}
