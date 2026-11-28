import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { addProject, DEFAULT_PROJECT, projectIdOf, projectNameError, type UserConfig } from "@ion/config";
import { git } from "./git.js";

export const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);

/** A repo ion makes for you: your git identity applies (nothing a run wrote is in a folder that's just been made). */
const yours = { yours: true };

export async function mustGit(args: string[], cwd: string, input?: string): Promise<string> {
  const r = await git(args, cwd, { ...yours, ...(input === undefined ? {} : { input }) });
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim().split("\n")[0]}`);
  return r.stdout.trim();
}

/** ion signs a commit only when you have no git identity. */
export async function identity(path: string): Promise<string[]> {
  const email = (await git(["config", "user.email"], path, yours)).stdout.trim();
  return email ? [] : ["-c", "user.name=ion", "-c", "user.email=ion@localhost"];
}

/** A new git repo with one empty commit (worktrees need one). */
async function initRepo(path: string): Promise<void> {
  mkdirSync(path, { recursive: true, mode: 0o755 });
  await mustGit(["init", "-q", "-b", "main"], path);
  await mustGit([...(await identity(path)), "commit", "-q", "--allow-empty", "-m", "Start"], path);
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
